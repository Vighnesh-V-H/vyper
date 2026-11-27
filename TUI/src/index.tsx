import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { errorMessage } from "../../src/errors";
import { App } from "./app";
import { loadTuiConfig } from "./config";
import { theme } from "./theme";

async function main(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
    backgroundColor: theme.background,
  });

  try {
    const config = loadTuiConfig();
    const root = createRoot(renderer);
    root.render(<App config={config} onExit={() => renderer.destroy()} />);
  } catch (error) {
    renderer.destroy();
    throw error;
  }
}

await main().catch((error: unknown) => {
  console.error(`vyper tui: ${errorMessage(error)}`);
  process.exitCode = 1;
});
