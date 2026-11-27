import { theme } from "../theme";
import type { ToolSummary, TuiConfig } from "../types";
import type { ChatState } from "../chat/state";
import { describePhase } from "../chat/state";
import { displayPath, shortId } from "../format";
import {
  Badge,
  Divider,
  SectionHeading,
  StatRow,
} from "../components/primitives";

function ToolEntry(props: { readonly tool: ToolSummary }) {
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" height={1}>
        <text fg={theme.success}>● </text>
        <text fg={theme.text}>
          <b>{props.tool.name}</b>
        </text>
        <text fg={theme.textDim}>
          {" "}
          · {props.tool.kind}
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" paddingLeft={2}>
        {props.tool.description}
      </text>
    </box>
  );
}

export interface ToolsScreenProps {
  readonly config: TuiConfig;
  readonly state: ChatState;
}

export function ToolsScreen(props: ToolsScreenProps) {
  const phase = describePhase(props.state);

  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      contentOptions={{ padding: 1, gap: 1 }}
    >
      <box flexDirection="column" width="100%" gap={1}>
        <SectionHeading
          title="registered tools"
          detail="JSON-schema validated inputs · bounded text results · explicit failures"
        />
        {props.config.toolSummaries.length === 0 ? (
          <text fg={theme.textDim}>No tools are registered.</text>
        ) : (
          props.config.toolSummaries.map((tool) => (
            <ToolEntry key={tool.name} tool={tool} />
          ))
        )}
      </box>

      <Divider />

      <box flexDirection="column" width="100%" gap={0}>
        <SectionHeading title="runtime" />
        <StatRow label="model" value={props.config.model} />
        <StatRow label="provider key" value={
          props.config.apiKey === undefined ? "not configured" : "configured"
        } color={
          props.config.apiKey === undefined ? theme.warning : theme.success
        } />
        <StatRow label="working dir" value={displayPath(props.config.cwd)} />
        <StatRow label="context" value="FullHistoryContext · every message" />
        <StatRow
          label="tool execution"
          value={
            props.config.toolConcurrency === 1
              ? "sequential · one at a time"
              : `concurrent · ${props.config.toolConcurrency} at a time`
          }
        />
        <StatRow label="max steps" value={`${props.config.maxSteps} model calls`} />
        <StatRow label="runtime" value={props.config.runtime} />
      </box>

      <Divider />

      <box flexDirection="column" width="100%" gap={0}>
        <SectionHeading title="live session" />
        <StatRow
          label="state"
          value={phase.label}
          color={phase.tone === "danger" ? theme.danger : theme.text}
        />
        <StatRow
          label="session"
          value={
            props.state.sessionId === undefined
              ? "not started · send a prompt to create one"
              : shortId(props.state.sessionId, 72)
          }
        />
        <StatRow
          label="storage"
          value={displayPath(props.config.sessionDirectory)}
        />
        <StatRow label="format" value="append-only JSONL · replayable" />
        <box flexDirection="row" gap={2} paddingTop={1}>
          <Badge label="builtin" tone="accent" />
          <text fg={theme.textDim}>read · grep · bash</text>
          <Badge label="app" tone="muted" />
          <text fg={theme.textDim}>clock</text>
        </box>
      </box>

      <Divider />

      <box flexDirection="column" width="100%">
        <SectionHeading title="tool boundary" />
        <text fg={theme.textMuted} wrapMode="word">
          Model arguments arrive as untrusted data. Each tool parses and
          validates them, paths stay inside the working directory, and results
          are capped before they reach the conversation.
        </text>
      </box>
    </scrollbox>
  );
}
