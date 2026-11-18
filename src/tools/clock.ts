import type { ToolDefinition } from "../types/tools";
import { isRecord } from "../util/is-record";

/** Example application tool, composed with the built-ins by the CLI. */
export const clockTool: ToolDefinition<Record<string, never>, string> = {
  name: "clock",
  description: "Return the current date and time in ISO 8601 format.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input)) throw new Error("Arguments must be an object");
    return {};
  },
  execute() {
    return new Date().toISOString();
  },
  render: (_args, result) => result,
};
