import { theme } from "../theme";
import type { TuiConfig } from "../types";
import { FEATURES } from "../features";
import { displayPath } from "../format";
import {
  Callout,
  Divider,
  KeyHint,
  SectionHeading,
  StatRow,
} from "../components/primitives";

function FeatureRow(props: { readonly feature: (typeof FEATURES)[number] }) {
  return (
    <box flexDirection="row" width="100%" alignItems="flex-start">
      <box width={2} flexShrink={0}>
        <text fg={theme.success}>✓</text>
      </box>
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={theme.text}>
          <b>{props.feature.title}</b>
          <span fg={theme.textDim}> · {props.feature.area}</span>
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {props.feature.detail}
        </text>
      </box>
    </box>
  );
}

export interface AboutScreenProps {
  readonly config: TuiConfig;
}

export function AboutScreen(props: AboutScreenProps) {
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      contentOptions={{ padding: 1, gap: 1 }}
    >
      <box flexDirection="column" width="100%">
        <text fg={theme.accent}>
          <b>VYPER</b>
        </text>
        <text fg={theme.text}>
          A compact coding agent harness built around small, typed contracts.
        </text>
        <text fg={theme.textDim}>
          OpenTUI + React front end · Bun runtime · Gemini provider
        </text>
      </box>

      <Divider />

      <box flexDirection="column" width="100%" gap={1}>
        <SectionHeading
          title="what is in place"
          detail={`${FEATURES.length} implemented capabilities`}
        />
        {FEATURES.map((feature) => (
          <FeatureRow key={feature.title} feature={feature} />
        ))}
      </box>

      <Divider />

      <box flexDirection="column" width="100%" gap={0}>
        <SectionHeading title="keyboard" />
        <KeyHint keyName="tab / shift+tab" label="switch between views" />
        <KeyHint keyName="enter" label="send the prompt" />
        <KeyHint keyName="esc" label="abort the running turn" />
        <KeyHint keyName="ctrl+n" label="start a new session" />
        <KeyHint keyName="ctrl+c" label="abort, then quit" />
        <text fg={theme.textDim} paddingTop={1}>
          /new in the composer also starts a fresh chat.
        </text>
      </box>

      <Divider />

      <box flexDirection="column" width="100%" gap={0}>
        <SectionHeading title="project" />
        <StatRow label="agent" value="src/agent/agent.ts" />
        <StatRow label="tools" value="src/tools" />
        <StatRow label="sessions" value="src/session" />
        <StatRow label="context" value="src/context" />
        <StatRow label="tui" value="TUI/src" />
        <StatRow
          label="session dir"
          value={displayPath(props.config.sessionDirectory)}
        />
        <StatRow label="install" value="bun install" />
        <StatRow label="run" value="bun run tui" />
        <StatRow label="test" value="bun test" />
        <StatRow label="typecheck" value="bun check" />
      </box>

      <Callout tone="muted">
        <text fg={theme.textMuted} wrapMode="word">
          The core loop never imports a tool, provider, or UI. This screen is an
          application composed from the harness modules under src/.
        </text>
      </Callout>
    </scrollbox>
  );
}
