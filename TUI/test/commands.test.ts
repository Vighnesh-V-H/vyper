import { describe, expect, test } from "bun:test";
import { COMMANDS, matchingCommands } from "../src/commands";

describe("slash commands", () => {
  test("lists every registered command for a slash prefix", () => {
    expect(matchingCommands("/").map((command) => command.name)).toEqual(
      COMMANDS.map((command) => command.name),
    );
  });

  test("filters commands by the current token", () => {
    expect(matchingCommands("/cl").map((command) => command.name)).toEqual([
      "/clear",
    ]);
    expect(matchingCommands("/quit ")).toEqual([]);
  });

  test("does not show suggestions for normal prompts or unknown commands", () => {
    expect(matchingCommands("explain this")).toEqual([]);
    expect(matchingCommands("/unknown")).toEqual([]);
  });
});
