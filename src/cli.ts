import { createInterface } from "node:readline/promises";
import { Agent } from "./agent/agent";
import { ChatSession } from "./cli-session";
import { WindowedContext } from "./context/windowed";
import { ERROR_MESSAGES, MissingApiKeyError, errorMessage } from "./errors";
import { GeminiModel } from "./providers/gemini";
import { clockTool } from "./tools/builtin/clock";
import { createToolRegistry } from "./tools/discovery";
import { AgentEventType, AgentStatus } from "./types/agent";
import type { AgentEvent, AgentResult } from "./types/agent";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_STEPS = 12;
const MAX_CONTEXT_TOKENS = 24_000;
const KEEP_RECENT_MESSAGES = 40;
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

  const agent = new Agent({
    model: new GeminiModel({ apiKey, model }),
    instructions: [
      "You are a coding assistant working inside the user's repository.",
      "Use the provided tools to inspect files before answering.",
      "Keep answers concise and reference concrete file paths.",
      "Do not run destructive shell commands.",
    ].join("\n"),
    tools: createToolRegistry({ tools: [clockTool] }),
    context: new WindowedContext({
      maxTokens: MAX_CONTEXT_TOKENS,
      keepMessages: KEEP_RECENT_MESSAGES,
    }),
    cwd: process.cwd(),
    maxSteps: MAX_STEPS,
    onEvent: printEvent,
  });

  if (prompt.length > 0) {
    await runOnce(agent, prompt);
    return;
  }

  await runInteractive(agent);
}

/** Non-interactive mode: one prompt from argv, then exit. */
async function runOnce(agent: Agent, prompt: string): Promise<void> {
  const controller = new AbortController();
  const stopOnInterrupt = (): void => controller.abort();
  process.once("SIGINT", stopOnInterrupt);

  try {
    const result = await agent.run(prompt, { signal: controller.signal });
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
async function runInteractive(agent: Agent): Promise<void> {
  const session = new ChatSession(agent);
  const onInterrupt = (): void => {
    if (session.isRunning) {
      session.abort();
      return;
    }
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);

  if (process.stdin.isTTY) {
    console.log("vyper chat. Type /exit to quit, /new to clear history.");
  }

  try {
    while (true) {
      const line = await readPrompt();
      if (line === null) break;

      const prompt = line.trim();
      if (prompt.length === 0) continue;

      const command = prompt.toLowerCase();
      if (EXIT_COMMANDS.has(command)) break;
      if (RESET_COMMANDS.has(command)) {
        session.reset();
        console.log("History cleared.");
        continue;
      }

      try {
        const result = await session.ask(prompt);
        reportTurnResult(result);
      } catch (error) {
        console.error(errorMessage(error));
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
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
