import { basename } from "node:path";
import { useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme";
import type { TuiConfig } from "../types";
import type { ChatState } from "../chat/state";
import { describePhase, type NoticeTone } from "../chat/state";
import { formatTokenCount, formatUsage, shortId } from "../format";
import { toneColor } from "./primitives";

export type View = "chat" | "tools" | "about";

export interface ViewOption {
  readonly id: View;
  readonly label: string;
}

export const VIEWS: readonly ViewOption[] = [
  { id: "chat", label: "chat" },
  { id: "tools", label: "tools" },
  { id: "about", label: "about" },
];

export interface HeaderProps {
  readonly config: TuiConfig;
}

export function Header(props: HeaderProps) {
  const { width } = useTerminalDimensions();
  const online = props.config.apiKey !== undefined;
  const project = basename(props.config.cwd) || props.config.cwd;
  const compact = width < 88;

  return (
    <box
      height={1}
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={theme.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none">
        <span fg={theme.accent}>
          <b>▰ VYPER</b>
        </span>
        {compact ? null : (
          <span fg={theme.textDim}> terminal coding agent</span>
        )}
      </text>
      <text wrapMode="none">
        <span fg={online ? theme.success : theme.warning}>●</span>
        <span fg={theme.textDim}>
          {" "}
          {online ? props.config.model : `offline · ${props.config.model}`}
        </span>
        {width < 100 ? null : (
          <span fg={theme.textDim}> · {project}</span>
        )}
      </text>
    </box>
  );
}

export interface TabBarProps {
  readonly active: View;
  readonly toolCount: number;
  readonly onChange: (view: View) => void;
}

export function TabBar(props: TabBarProps) {
  return (
    <box
      height={1}
      flexDirection="row"
      backgroundColor={theme.surfaceRaised}
      paddingLeft={1}
    >
      {VIEWS.map((view) => {
        const selected = view.id === props.active;
        const label =
          view.id === "tools" ? `${view.label} ${props.toolCount}` : view.label;
        return (
          <box
            key={view.id}
            height={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={selected ? theme.accent : undefined}
            onMouseDown={() => props.onChange(view.id)}
          >
            <text fg={selected ? theme.background : theme.textMuted}>
              <b>{label}</b>
            </text>
          </box>
        );
      })}
    </box>
  );
}

export interface StatusBarProps {
  readonly state: ChatState;
  readonly maxSteps: number;
}

export function StatusBar(props: StatusBarProps) {
  const { width } = useTerminalDimensions();
  const phase = describePhase(props.state);
  const usage = formatUsage(
    props.state.usage.inputTokens,
    props.state.usage.outputTokens,
  );
  const showSession = width >= 112 && props.state.sessionId !== undefined;
  const showUsage =
    width >= 96 &&
    props.state.usage.inputTokens + props.state.usage.outputTokens > 0;
  const showEstimate =
    width >= 132 && props.state.tokensEstimated !== undefined;
  const hints =
    width >= 104
      ? "tab view · enter send · esc abort · ctrl+n new · ctrl+c quit"
      : width >= 72
        ? "tab · enter · esc · ^n · ^c"
        : "tab · ^c";

  return (
    <box
      height={1}
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={theme.surfaceRaised}
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none" flexShrink={1}>
        <span fg={toneColor(phase.tone)}>●</span>
        <span fg={theme.text}> {phase.label}</span>
        {showSession ? (
          <span fg={theme.textDim}>
            {" "}
            · session {shortId(props.state.sessionId ?? "")}
          </span>
        ) : null}
        {showUsage ? (
          <span fg={theme.textDim}> · {usage}</span>
        ) : null}
        {showEstimate ? (
          <span fg={theme.textDim}>
            {" "}
            · ~{formatTokenCount(props.state.tokensEstimated ?? 0)} ctx · max{" "}
            {props.maxSteps} steps
          </span>
        ) : null}
      </text>
      <text wrapMode="none" fg={theme.textDim} flexShrink={0}>
        {hints}
      </text>
    </box>
  );
}

export type { NoticeTone };
