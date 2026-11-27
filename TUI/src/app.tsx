import { useCallback, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "./theme";
import type { TuiConfig } from "./types";
import { useChat } from "./chat/use-chat";
import { Header, StatusBar } from "./components/chrome";
import { ChatScreen } from "./screens/chat";
import { COMMANDS, matchingCommands } from "./commands";

export interface AppProps {
  readonly config: TuiConfig;
  readonly onExit: () => void;
}

/**
 * Shell for all views. The chat controller lives here so a running turn keeps
 * going while the user inspects tools or the harness inventory.
 */
export function App(props: AppProps) {
  // Drafts live above the screen switch so inspecting tools never loses text.
  const [draft, setDraft] = useState("");
  const [selectedCommand, setSelectedCommand] = useState(0);
  const chat = useChat(props.config);
  const commandSuggestions = useMemo(
    () => matchingCommands(draft),
    [draft],
  );

  const executeCommand = useCallback(
    (commandName: string): void => {
      const command = COMMANDS.find((item) => item.name === commandName);
      if (command === undefined) return;
      if (command.action === "new") {
        void chat.startNew();
      } else if (!chat.busy) {
        props.onExit();
      }
      setDraft("");
    },
    [chat, props],
  );

  const submit = useCallback(
    (value: string): void => {
      const command = value.trim().toLowerCase();
      if (COMMANDS.some((item) => item.name === command)) {
        executeCommand(command);
        return;
      }
      void chat.send(value);
    },
    [chat, executeCommand],
  );

  useKeyboard((key) => {
    if (commandSuggestions.length > 0 && key.name === "down") {
      key.preventDefault();
      setSelectedCommand((current) => (current + 1) % commandSuggestions.length);
      return;
    }

    if (commandSuggestions.length > 0 && key.name === "up") {
      key.preventDefault();
      setSelectedCommand((current) =>
        (current - 1 + commandSuggestions.length) % commandSuggestions.length,
      );
      return;
    }

    if (commandSuggestions.length > 0 && key.name === "tab") {
      key.preventDefault();
      const command = commandSuggestions[selectedCommand];
      if (command !== undefined) setDraft(`${command.name} `);
      return;
    }

    if (commandSuggestions.length > 0 && key.name === "return") {
      key.preventDefault();
      const command = commandSuggestions[selectedCommand];
      if (command !== undefined) executeCommand(command.name);
      return;
    }

    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (chat.busy) {
        chat.abort();
        return;
      }
      props.onExit();
      return;
    }

    if (key.ctrl && key.name === "n") {
      key.preventDefault();
      void chat.startNew();
      return;
    }

    if (key.name === "escape" && chat.busy) {
      key.preventDefault();
      chat.abort();
    }
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      <Header config={props.config} />
      <ChatScreen
        config={props.config}
        chat={chat}
        draft={draft}
        onDraftChange={(value) => {
          setDraft(value);
          setSelectedCommand(0);
        }}
        commandSuggestions={commandSuggestions}
        selectedCommand={selectedCommand}
        onSubmit={submit}
      />
      <StatusBar state={chat.state} maxSteps={props.config.maxSteps} />
    </box>
  );
}
