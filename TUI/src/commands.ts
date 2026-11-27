export interface TuiCommand {
  readonly name: string;
  readonly description: string;
  readonly action: "new" | "exit";
}

/** Every slash command handled by the TUI, including aliases. */
export const COMMANDS: readonly TuiCommand[] = [
  { name: "/new", description: "Start a fresh chat", action: "new" },
  { name: "/clear", description: "Start a fresh chat", action: "new" },
  { name: "/exit", description: "Quit Vyper", action: "exit" },
  { name: "/quit", description: "Quit Vyper", action: "exit" },
];

/** Show all commands for `/`, and narrow the list as the user types. */
export function matchingCommands(value: string): readonly TuiCommand[] {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/")) return [];
  if (/\s/.test(trimmed)) return [];
  return COMMANDS.filter((command) => command.name.startsWith(trimmed.toLowerCase()));
}
