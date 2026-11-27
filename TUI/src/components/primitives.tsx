import type { ReactNode } from "react";
import { theme } from "../theme";
import type { NoticeTone } from "../chat/state";

const TONE_COLOR: Record<NoticeTone, string> = {
  muted: theme.textDim,
  success: theme.success,
  warning: theme.warning,
  danger: theme.danger,
};

export function toneColor(tone: NoticeTone | "accent"): string {
  return tone === "accent" ? theme.accent : TONE_COLOR[tone];
}

export interface SectionHeadingProps {
  readonly title: string;
  readonly detail?: string;
}

/** Compact uppercase section label with an optional explanatory line. */
export function SectionHeading(props: SectionHeadingProps) {
  return (
    <box flexDirection="column">
      <text fg={theme.accent}>
        <b>{props.title.toUpperCase()}</b>
      </text>
      {props.detail === undefined ? null : (
        <text fg={theme.textDim}>{props.detail}</text>
      )}
    </box>
  );
}

export function Divider() {
  return <box height={1} border={["top"]} borderColor={theme.border} />;
}

export interface StatRowProps {
  readonly label: string;
  readonly value: string;
  readonly color?: string;
  readonly labelWidth?: number;
}

/** Dense label/value row used by the runtime and about screens. */
export function StatRow(props: StatRowProps) {
  return (
    <box flexDirection="row" width="100%" alignItems="flex-start">
      <box width={props.labelWidth ?? 18} flexShrink={0}>
        <text fg={theme.textDim}>{props.label}</text>
      </box>
      <box flexGrow={1} minWidth={0}>
        <text fg={props.color ?? theme.text} wrapMode="word">
          {props.value}
        </text>
      </box>
    </box>
  );
}

export interface CalloutProps {
  readonly tone: NoticeTone;
  readonly children: ReactNode;
}

/** A lightweight left-accented note, avoiding a full bordered card. */
export function Callout(props: CalloutProps) {
  return (
    <box
      flexDirection="column"
      border={["left"]}
      borderColor={toneColor(props.tone)}
      paddingLeft={1}
    >
      {props.children}
    </box>
  );
}

export interface KeyHintProps {
  readonly keyName: string;
  readonly label: string;
}

export function KeyHint(props: KeyHintProps) {
  return (
    <text>
      <span fg={theme.accent}>{props.keyName}</span>
      <span fg={theme.textDim}> {props.label}</span>
    </text>
  );
}

export interface BadgeProps {
  readonly label: string;
  readonly tone?: NoticeTone | "accent";
}

export function Badge(props: BadgeProps) {
  return (
    <text fg={toneColor(props.tone ?? "muted")}>
      <b>{props.label}</b>
    </text>
  );
}
