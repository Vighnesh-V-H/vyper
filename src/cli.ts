import { createInterface } from "node:readline/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Agent } from "./agent/agent";
import { ChatSession } from "./session/chat";
import { FullHistoryContext } from "./context/full-history";
import { ERROR_MESSAGES, MissingApiKeyError, errorMessage } from "./errors";
import { FileEventLog } from "./event-log/file";
import { GeminiModel } from "./providers/gemini";
import { SessionEventCodec } from "./session/codec";
import { SessionLog } from "./session/log";
import { clockTool } from "./tools/builtin/clock";
import { createToolRegistry } from "./tools/discovery";
import { AgentEventType, AgentStatus } from "./types/agent";
import type { AgentEvent, AgentResult } from "./types/agent";
import { asSessionId } from "./types/ids";
import type { SessionEvent } from "./types/session";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_STEPS = 12;
const DEFAULT_SESSION_DIRECTORY = resolve(
  homedir(),
  ".vyper",
  "agent",
  "sessions",
);
const EXIT_COMMANDS = new Set(["/exit", "/quit"]);
const RESET_COMMANDS = new Set(["/new", "/clear"]);

export async function main(): Promise<void> {
  const apiKeyVariable = "GOOGLE_GENERATIVE_AI_API_KEY";
  const apiKey = process.env[apiKeyVariable]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new MissingApiKeyError(apiKeyVariable);
  }

  const prompt = process.argv.slice(2).join(" ").trim();
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const instructions = [
    "You are a coding assistant working inside the user's repository.",
    "Use the provided tools to inspect files before answering.",
    "Keep answers concise and reference concrete file paths.",
    "Do not run destructive shell commands.",
  ].join("\n");

  const agent = new Agent({
    model: new GeminiModel({ apiKey, model }),
    instructions,
    tools: createToolRegistry({ tools: [clockTool] }),
    context: new FullHistoryContext(),
    cwd: process.cwd(),
    maxSteps: MAX_STEPS,
    onEvent: printEvent,
  });

  const sessionDirectory = resolveSessionDirectory(
    process.cwd(),
    process.env.VYPER_SESSION_DIR,
  );
  const configuredSessionId = process.env.VYPER_SESSION_ID?.trim();
  const openChat = async (firstPrompt: string, forceNew = false) => {
    const sessionId =
      !forceNew && configuredSessionId
        ? configuredSessionId
        : createPromptSessionId(firstPrompt);
    const codec = new SessionEventCodec();
    const session = await SessionLog.open({
      log: new FileEventLog<SessionEvent>({
        directory: sessionDirectory,
        codec,
      }),
      codec,
      sessionId: asSessionId(sessionId),
      model,
      instructions,
      cwd: process.cwd(),
      appConfig: {
        maxSteps: MAX_STEPS,
        preserveFullHistory: true,
      },
    });
    const chat = await ChatSession.open({ agent, session });
    if (process.stdin.isTTY && chat.messages.length > 0) {
      console.log(
        `Resumed session "${sessionId}" with ${chat.messages.length} messages.`,
      );
    }
    return { chat, sessionId };
  };

  if (prompt.length > 0) {
    const { chat } = await openChat(prompt);
    try {
      await runOnce(chat, prompt);
    } finally {
      await chat.close();
    }
    return;
  }

  await runInteractive(openChat);
}

/** Create a filesystem-safe, unique session id whose prefix comes from its first prompt. */
export function createPromptSessionId(
  prompt: string,
  timestamp = Date.now(),
): string {
  const slug = prompt
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${slug || "chat"}-${timestamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Resolve the project-scoped durable session directory. The explicit override
 * retains its historical project-relative behavior; the default follows Pi's
 * per-user session layout.
 */
export function resolveSessionDirectory(
  cwd: string,
  override: string | undefined,
): string {
  const configured = override?.trim();
  if (configured) return resolve(cwd, configured);
  const projectPath = resolve(cwd);
  const projectKey = createHash("sha256").update(projectPath).digest("hex");
  return resolve(DEFAULT_SESSION_DIRECTORY, projectKey);
}

/** Non-interactive mode: one prompt from argv, then exit. */
async function runOnce(chat: ChatSession, prompt: string): Promise<void> {
  const stopOnInterrupt = (): void => chat.abort();
  process.once("SIGINT", stopOnInterrupt);

  try {
    const result = await chat.ask(prompt);
    reportOneShotResult(result);
  } finally {
    process.off("SIGINT", stopOnInterrupt);
  }
}

/**
 * Interactive mode: keep reading prompts and carry the conversation forward.
 *
 * Each turn hands the previous result's messages back to the agent. Ctrl+C
 * aborts the current turn while it runs, and exits while waiting for input.
 */
async function runInteractive(
  openChat: (
    firstPrompt: string,
    forceNew?: boolean,
  ) => Promise<{ readonly chat: ChatSession; readonly sessionId: string }>,
): Promise<void> {
  let current: ChatSession | undefined;
  const onInterrupt = (): void => {
    if (current?.isRunning) {
      current.abort();
      return;
    }
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);

  if (process.stdin.isTTY) {
    console.log("vyper chat. Type /exit to quit, /new to start a separate chat.");
  }

  let forceNew = false;
  try {
    while (true) {
      const line = await readPrompt();
      if (line === null) break;

      const prompt = line.trim();
      if (prompt.length === 0) continue;

      const command = prompt.toLowerCase();
      if (EXIT_COMMANDS.has(command)) break;
      if (RESET_COMMANDS.has(command)) {
        if (current !== undefined) {
          await current.close();
          current = undefined;
        }
        forceNew = true;
        console.log("Started a new chat.");
        continue;
      }

      try {
        if (current === undefined) {
          const opened = await openChat(prompt, forceNew);
          current = opened.chat;
          forceNew = false;
        }
        const result = await current.ask(prompt);
        reportTurnResult(result);
      } catch (error) {
        console.error(errorMessage(error));
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    if (current !== undefined) await current.close();
  }
}

/**
 * Read one line. A fresh interface per turn leaves stdin in normal mode while
 * the agent runs, so Ctrl+C reaches the process interrupt handler.
 */
async function readPrompt(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const interrupted = new Promise<null>((resolve) => {
      rl.once("SIGINT", () => resolve(null));
    });
    const closed = new Promise<null>((resolve) => {
      rl.once("close", () => resolve(null));
    });
    return await Promise.race([rl.question("> "), interrupted, closed]);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case AgentEventType.ToolStart:
      console.error(`tool: ${event.name}`);
      break;
    case AgentEventType.ToolResult:
      console.error(
        `tool: ${event.result.name} ${event.result.isError ? "failed" : "done"} (${event.result.durationMs}ms)`,
      );
      break;
    case AgentEventType.Warning:
      console.error(`warning (${event.stage}): ${event.error.message}`);
      break;
    case AgentEventType.Error:
      console.error(`error (${event.stage}): ${event.error.message}`);
      break;
  }
}

function reportOneShotResult(result: AgentResult): void {
  if (result.status === AgentStatus.Error) {
    console.error(`Agent failed at ${result.stage}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.status === AgentStatus.Aborted) {
    console.error(ERROR_MESSAGES.agent.runAborted);
    process.exitCode = 130;
    return;
  }

  console.log(result.output);
  if (result.status === AgentStatus.MaxSteps) {
    console.error(`Stopped after ${result.steps} model calls.`);
    process.exitCode = 1;
  }
}

function reportTurnResult(result: AgentResult): void {
  switch (result.status) {
    case AgentStatus.Completed:
      if (result.output.length > 0) console.log(result.output);
      return;
    case AgentStatus.MaxSteps:
      if (result.output.length > 0) console.log(result.output);
      console.error(`Stopped after ${result.steps} model calls.`);
      return;
    case AgentStatus.Aborted:
      console.error(ERROR_MESSAGES.agent.runAborted);
      return;
    case AgentStatus.Error:
      console.error(`Agent failed at ${result.stage}: ${result.error.message}`);
      return;
  }
}
