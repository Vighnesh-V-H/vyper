import type { ChatController } from "../chat/use-chat";
import type { TuiConfig } from "../types";
import { Composer, Transcript } from "../components/transcript";
import type { TuiCommand } from "../commands";

export interface ChatScreenProps {
  readonly config: TuiConfig;
  readonly chat: ChatController;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly commandSuggestions: readonly TuiCommand[];
  readonly selectedCommand: number;
}

/** The only screen with live agent state; panels stay inside the transcript. */
export function ChatScreen(props: ChatScreenProps) {
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <Transcript items={props.chat.state.items} config={props.config} />
      <Composer
        value={props.draft}
        running={props.chat.busy}
        hasApiKey={props.config.apiKey !== undefined}
        onDraftChange={props.onDraftChange}
        commandSuggestions={props.commandSuggestions}
        selectedCommand={props.selectedCommand}
        onSubmit={props.onSubmit}
      />
    </box>
  );
}
