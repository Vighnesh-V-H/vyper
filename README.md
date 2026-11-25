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

Sessions are stored as append-only JSONL under
`~/.vyper/agent/sessions/<project-key>/` by default. The key is a stable SHA-256
hash of the resolved project path, so same-named directories in different
locations cannot share session history. Each JSONL record is a typed event with
an `id` and `parentId` link. The prompt event is flushed before the model call;
completed turns append their full message snapshot. Completed, max-steps, and
aborted turns commit the conversation they reached, preserving partial progress
on cancellation. Restarting the CLI resumes the last committed conversation.
Failed turns are retracted from active history while their events remain in the
append-only log.

The CLI sends the full restored conversation on every model call; it does not
silently drop older messages. Very long conversations can exceed the model's
context limit and then fail explicitly at the provider rather than losing
history.

- `VYPER_SESSION_ID` selects a session (default: `default`).
- `VYPER_SESSION_DIR` overrides the storage directory (relative paths resolve
  from the project directory).
- `/new` and `/clear` append a durable reset.

Library users can compose `FileEventLog`,
`SessionLog.open()`, and `ChatSession.open()` directly.

To type check:

```bash
bun check
```

Run `bun fmt` to format the code.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
