# vyper

To install dependencies:

```bash
bun install
```

To run interactively:

```bash
bun run index.ts
```

Type a prompt and press Enter. The conversation continues across turns; use
`/new` to clear history and `/exit` to quit. Ctrl+C aborts the current turn.

To run a single prompt and exit:

```bash
bun run index.ts "summarize src/agent/agent.ts"
```

Set `GOOGLE_GENERATIVE_AI_API_KEY` before running.

## Session persistence

Sessions are stored as append-only JSONL under `.vyper/sessions/`. Each turn is
recorded as it runs and flushed before the committed conversation advances, so
restarting the CLI resumes the last completed turn. Interrupted and failed turns
are retracted rather than folded into history.

- `VYPER_SESSION_ID` selects a session (default: `default`).
- `VYPER_SESSION_DIR` overrides the storage directory.
- `/new` and `/clear` append a durable reset.

`.vyper/` is excluded from git. Library users can compose `FileEventLog`,
`SessionLog.open()`, and `ChatSession.open()` directly.

To type check:

```bash
bun check
```

Run `bun fmt` to format the code.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
