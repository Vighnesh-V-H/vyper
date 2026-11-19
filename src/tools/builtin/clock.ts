import { ERROR_MESSAGES, ToolInputError } from "../../errors";
import type { ToolDefinition } from "../../types/tools";
import { isRecord } from "../../util/is-record";

export const clockTool: ToolDefinition<Record<string, never>, string> = {
  name: "clock",
  description: "Return the current date and time in ISO 8601 format.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input)) {
      throw new ToolInputError(ERROR_MESSAGES.tools.argumentsMustBeObject);
    }
    return {};
  },
  execute() {
    return new Date().toISOString();
  },
  render: (_args, result) => result,
};
