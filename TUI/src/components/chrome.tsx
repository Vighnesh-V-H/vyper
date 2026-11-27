import { basename } from "node:path";
import { useTerminalDimensions } from "@opentui/react";
import { theme } from "../theme";
import type { TuiConfig } from "../types";
import type { ChatState } from "../chat/state";
import { describePhase, type NoticeTone } from "../chat/state";
import { formatTokenCount, formatUsage, shortId } from "../format";
import { toneColor } from "./primitives";

export interface HeaderProps {
  readonly config: TuiConfig;
  readonly state: ChatState;
}

export function Header(props: HeaderProps) {
  const { width } = useTerminalDimensions();
  const online = props.config.apiKey !== undefined;
  const project = basename(props.config.cwd) || props.config.cwd;
  const context = props.state.tokensEstimated === undefined
    ? "context —"
    : `context ${formatTokenCount(props.state.tokensEstimated)} tokens`;
  const phase = props.state.phase === "running" ? "thinking" : "idle";

  return (
    <box
      height={2}
      flexDirection="column"
      backgroundColor={theme.surface}
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none">
        <span fg={theme.accent}><b>▰ VYPER</b></span>
        <span fg={theme.textDim}> terminal coding agent</span>
      </text>
      <box flexDirection="row" justifyContent="space-between">
        <text wrapMode="none">
          <span fg={theme.accent}>{props.config.branch}</span>
          <span fg={theme.textDim}> · {context}</span>
        </text>
        <text wrapMode="none" fg={theme.textDim}>
          {online ? props.config.model : `offline · ${props.config.model}`} · {phase}{width >= 100 ? ` · ${project}` : ""}
        </text>
      </box>
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
