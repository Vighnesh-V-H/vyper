import { useCallback, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "./theme";
import type { TuiConfig } from "./types";
import { useChat } from "./chat/use-chat";
import { Header, StatusBar, TabBar, VIEWS, type View } from "./components/chrome";
import { AboutScreen } from "./screens/about";
import { ChatScreen } from "./screens/chat";
import { ToolsScreen } from "./screens/tools";

export interface AppProps {
  readonly config: TuiConfig;
  readonly onExit: () => void;
}

function nextView(current: View, direction: 1 | -1): View {
  const index = VIEWS.findIndex((view) => view.id === current);
  const next = (index + direction + VIEWS.length) % VIEWS.length;
  return VIEWS[next]?.id ?? "chat";
}

/**
 * Shell for all views. The chat controller lives here so a running turn keeps
 * going while the user inspects tools or the harness inventory.
 */
export function App(props: AppProps) {
  const [view, setView] = useState<View>("chat");
  // Drafts live above the screen switch so inspecting tools never loses text.
  const [draft, setDraft] = useState("");
  const chat = useChat(props.config);

  const submit = useCallback(
    (value: string): void => {
      const command = value.trim().toLowerCase();
      if (command === "/new" || command === "/clear") {
        void chat.startNew();
        return;
      }
      if (command === "/exit" || command === "/quit") {
        if (!chat.busy) props.onExit();
        return;
      }
      void chat.send(value);
    },
    [chat, props],
  );

  useKeyboard((key) => {
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

    if (key.name === "tab") {
      key.preventDefault();
      setView((current) => nextView(current, key.shift ? -1 : 1));
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
      <TabBar
        active={view}
        toolCount={props.config.toolSummaries.length}
        onChange={setView}
      />
      <box flexGrow={1} minHeight={0}>
        {view === "chat" ? (
          <ChatScreen
            config={props.config}
            chat={chat}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={submit}
          />
        ) : view === "tools" ? (
          <ToolsScreen config={props.config} state={chat.state} />
        ) : (
          <AboutScreen config={props.config} />
        )}
      </box>
      <StatusBar state={chat.state} maxSteps={props.config.maxSteps} />
    </box>
  );
}
