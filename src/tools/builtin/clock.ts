import type { JsonObjectSchema } from "../../types/json-schema";
import { readArguments } from "../arguments";
import { defineTool } from "../define-tool";

export const clockTool = defineTool({
  name: "clock",
  description: "Return the current date and time in ISO 8601 format.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  } as const satisfies JsonObjectSchema,
  parse(input) {
    readArguments(input);
    return {};
  },
  execute() {
    return new Date().toISOString();
  },
  render: (_args, result) => result,
});
