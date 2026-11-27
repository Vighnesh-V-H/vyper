# Vyper TUI

A compact OpenTUI + React front end for the existing harness. It does not
reimplement the agent: chat uses `Agent`, the tool registry, `FullHistoryContext`,
`GeminiModel`, and prompt-named `ChatSession` persistence directly.

```bash
bun install
bun run tui
```

Set `GOOGLE_GENERATIVE_AI_API_KEY` in `.env` to chat. Without a key the TUI
still opens so you can inspect tools and the harness inventory.

## Views

- **chat** — live transcript with agent responses, tool activity, usage, and
  durable prompt-named sessions.
- **tools** — every registered tool plus engine and session details.
- **about** — the capabilities implemented so far and keyboard reference.

## Keys

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | switch view |
| `enter` | send prompt |
| `esc` | abort the running turn |
| `ctrl+n` | start a new session |
| `ctrl+c` | abort, then quit |

Type `/` in the composer to list every slash command. Use `↑` / `↓` to select,
`tab` to complete the highlighted command, and `enter` to execute it. Commands
are filtered as you type: `/new` and `/clear` start a fresh chat; `/exit` and
`/quit` quit Vyper.

## Structure

```
TUI/src/
  index.tsx              renderer + entry point
  app.tsx                shell, view switching, global keys
  config.ts              composition root
  theme.ts               palette
  features.ts            "what is in place" inventory
  chat/
    state.ts             pure event -> transcript reducer
    session.ts           Agent + durable ChatSession construction
    use-chat.ts          lifecycle hook
  components/            reusable primitives and chat chrome
  screens/               chat, tools, about
```

The TUI depends on the public library modules under `src/`; the core agent loop
has no knowledge of this application.
