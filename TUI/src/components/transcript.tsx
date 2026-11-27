import { theme } from "../theme";
import type { TuiConfig } from "../types";
import type { TuiCommand } from "../commands";
import type {
  NoticeTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
} from "../chat/state";
import { displayPath, formatDuration, preview } from "../format";
import { Callout, KeyHint, SectionHeading, toneColor } from "./primitives";

const NOTICE_PREFIX: Record<NoticeTranscriptItem["tone"], string> = {
  muted: "·",
  success: "✓",
  warning: "▲",
  danger: "✖",
};

function UserRow(props: { readonly text: string }) {
  return (
    <box
      flexDirection="column"
      width="100%"
      backgroundColor={theme.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.accent}>
        <b>YOU</b>
      </text>
      <text fg={theme.text} wrapMode="word" selectable>
        {props.text}
      </text>
    </box>
  );
}

function AssistantRow(props: { readonly text: string; readonly partial: boolean }) {
  return (
    <box flexDirection="column" width="100%">
      <text fg={theme.purple}>
        <b>VYPER</b>
        {props.partial ? <span fg={theme.warning}> partial</span> : null}
      </text>
      <text fg={theme.text} wrapMode="word" selectable>
        {props.text}
      </text>
    </box>
  );
}

function toolStatus(tool: ToolTranscriptItem): {
  readonly icon: string;
  readonly color: string;
  readonly label: string;
} {
  if (tool.status === "running") {
    return { icon: "◌", color: theme.warning, label: "running" };
  }
  if (tool.status === "error") {
    return { icon: "✖", color: theme.danger, label: "failed" };
  }
  return { icon: "✓", color: theme.success, label: "done" };
}

function ToolRow(props: { readonly tool: ToolTranscriptItem }) {
  const status = toolStatus(props.tool);
  const timing =
    props.tool.durationMs === undefined
      ? ""
      : ` · ${formatDuration(props.tool.durationMs)}`;

  return (
    <box flexDirection="column" width="100%">
      <text wrapMode="none">
        <span fg={status.color}>{status.icon}</span>
        <span fg={theme.text}>
          {" "}
          <b>{props.tool.name}</b>
        </span>
        <span fg={theme.textDim}>
          {" "}
          {status.label}
          {timing}
        </span>
      </text>
      {props.tool.detail === undefined ? null : (
        <text fg={theme.textDim} wrapMode="word" paddingLeft={2}>
          {props.tool.detail}
        </text>
      )}
    </box>
  );
}

function NoticeRow(props: { readonly notice: NoticeTranscriptItem }) {
  return (
    <text fg={toneColor(props.notice.tone)} wrapMode="word">
      {NOTICE_PREFIX[props.notice.tone]} {props.notice.text}
    </text>
  );
}

function TranscriptRow(props: { readonly item: TranscriptItem }) {
  switch (props.item.kind) {
    case "user":
      return <UserRow text={props.item.text} />;
    case "assistant":
      return (
        <AssistantRow text={props.item.text} partial={props.item.partial} />
      );
    case "tool":
      return <ToolRow tool={props.item} />;
    case "notice":
      return <NoticeRow notice={props.item} />;
  }
}

export interface EmptyStateProps {
  readonly config: TuiConfig;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <box flexDirection="column" width="100%" gap={1}>
      <box flexDirection="column">
        <ascii-font text="VYPER" font="tiny" color={theme.accent} />
        <text fg={theme.text}>
          A small terminal coding agent with a typed, provider-neutral loop.
        </text>
      </box>

      {props.config.apiKey === undefined ? (
        <Callout tone="warning">
          <text fg={theme.warning}>
            GOOGLE_GENERATIVE_AI_API_KEY is not set.
          </text>
          <text fg={theme.textDim}>
            Add it to .env and restart to chat. Tool inspection and this
            interface still work offline.
          </text>
        </Callout>
      ) : null}

      <box flexDirection="column">
        <SectionHeading title="try" />
        <text fg={theme.textMuted}>
          read src/agent/agent.ts and explain the loop
        </text>
        <text fg={theme.textMuted}>
          find every place sessions are persisted
        </text>
        <text fg={theme.textMuted}>
          which tools do you have, and what are they for?
        </text>
      </box>

      <box flexDirection="column">
        <SectionHeading title="local" />
        <text fg={theme.textDim} wrapMode="word">
          sessions are appended to {displayPath(props.config.sessionDirectory)}
        </text>
        <text fg={theme.textDim}>
          {props.config.toolSummaries.length} tools · {props.config.maxSteps} max
          steps · full history
        </text>
      </box>

      <box flexDirection="column">
        <SectionHeading title="keys" />
        <box flexDirection="row" gap={2}>
          <KeyHint keyName="enter" label="send" />
          <KeyHint keyName="esc" label="abort" />
          <KeyHint keyName="tab" label="switch view" />
          <KeyHint keyName="ctrl+n" label="new chat" />
        </box>
      </box>
    </box>
  );
}

export interface TranscriptProps {
  readonly items: readonly TranscriptItem[];
  readonly config: TuiConfig;
}

export function Transcript(props: TranscriptProps) {
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      stickyScroll
      stickyStart="bottom"
      contentOptions={{ paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1, gap: 1 }}
    >
      {props.items.length === 0 ? (
        <EmptyState config={props.config} />
      ) : (
        props.items.map((item) => (
          <TranscriptRow key={item.id} item={item} />
        ))
      )}
    </scrollbox>
  );
}

export interface ComposerProps {
  readonly value: string;
  readonly running: boolean;
  readonly hasApiKey: boolean;
  readonly commandSuggestions: readonly TuiCommand[];
  readonly selectedCommand: number;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}

export function Composer(props: ComposerProps) {
  const placeholder = props.running
    ? "Vyper is working · esc aborts"
    : props.hasApiKey
      ? "Ask Vyper to read, find, run, or explain…"
      : "Set GOOGLE_GENERATIVE_AI_API_KEY in .env to chat";

  const submit = (next: string): void => {
    if (props.running) return;
    const prompt = next.trim();
    if (prompt.length === 0) return;
    props.onDraftChange("");
    props.onSubmit(prompt);
  };

  return (
    <box flexDirection="column" flexShrink={0}>
      {props.commandSuggestions.length > 0 ? (
        <box
          flexDirection="column"
          backgroundColor={theme.surfaceRaised}
          paddingLeft={1}
          paddingRight={1}
        >
          {props.commandSuggestions.map((command, index) => (
            <box
              key={command.name}
              backgroundColor={
                index === props.selectedCommand ? theme.border : theme.surfaceRaised
              }
            >
              <text
                fg={index === props.selectedCommand ? theme.text : theme.textMuted}
                wrapMode="none"
              >
                {index === props.selectedCommand ? "❯ " : "  "}
                <b>{command.name}</b>
                <span fg={theme.textDim}>  {command.description}</span>
              </text>
            </box>
          ))}
          <text fg={theme.textDim} wrapMode="none">
            ↑/↓ navigate · tab complete · enter run
          </text>
        </box>
      ) : null}
      <box
        height={2}
        flexDirection="row"
        alignItems="center"
        border={["top"]}
        borderColor={theme.border}
        backgroundColor={theme.surface}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={props.running ? theme.warning : theme.accent} flexShrink={0}>
          {props.running ? "●" : "❯"}{" "}
        </text>
        <input
          flexGrow={1}
          minWidth={0}
          value={props.value}
          placeholder={placeholder}
          focused
          onInput={props.onDraftChange}
          onSubmit={submit}
          backgroundColor={theme.surface}
          focusedBackgroundColor={theme.surface}
          textColor={theme.text}
          focusedTextColor={theme.text}
          placeholderColor={theme.textDim}
          cursorColor={theme.accent}
          maxLength={4_000}
        />
      </box>
    </box>
  );
}

/** Exported for small render tests and future transcript tooling. */
export function toolPreview(tool: ToolTranscriptItem): string {
  return tool.detail === undefined ? "" : preview(tool.detail, 180);
}
