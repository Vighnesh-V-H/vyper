import { Agent } from "./agent/agent";
import { WindowedContext } from "./context/windowed";
import { GeminiModel } from "./providers/gemini";
import { clockTool } from "./tools/clock";
import { createToolRegistry } from "./tools/discovery";
import type { AgentEvent, AgentResult } from "./types/agent";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_PROMPT =
  "Inspect src/agent/agent.ts with the read tool and summarize the loop invariants.";
const MAX_STEPS = 12;
const MAX_CONTEXT_TOKENS = 24_000;
const KEEP_RECENT_MESSAGES = 40;

export async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set. Add it to .env first.");
  }

  const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT;
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

  const controller = new AbortController();
  const stopOnInterrupt = (): void => controller.abort();
  process.once("SIGINT", stopOnInterrupt);

  try {
    const result = await agent.run(prompt, { signal: controller.signal });
    reportResult(result);
  } finally {
    process.off("SIGINT", stopOnInterrupt);
  }
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "tool-start":
      console.error(`tool: ${event.name}`);
      break;
    case "tool-result":
      console.error(
        `tool: ${event.result.name} ${event.result.isError ? "failed" : "done"} (${event.result.durationMs}ms)`,
      );
      break;
    case "warning":
      console.error(`warning (${event.stage}): ${event.error.message}`);
      break;
    case "error":
      console.error(`error (${event.stage}): ${event.error.message}`);
      break;
  }
}

function reportResult(result: AgentResult): void {
  if (result.status === "error") {
    console.error(`Agent failed at ${result.stage}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.status === "aborted") {
    console.error("Run aborted.");
    process.exitCode = 130;
    return;
  }

  console.log(result.output);
  if (result.status === "max-steps") {
    console.error(`Stopped after ${result.steps} model calls.`);
    process.exitCode = 1;
  }
}
