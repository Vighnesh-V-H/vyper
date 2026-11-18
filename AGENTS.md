# Agent Harness Development Instructions

## Goal
Build a coding-agent harness comparable in capability to pi, with a small, understandable core. The project already has initial tool types, context types, and agent code; treat these as a starting point, not as a finished or authoritative design. Improve or replace them where needed rather than preserving weak abstractions for compatibility.

## Core requirements
- Design and implement an end-to-end agent loop with strong TypeScript typing across model requests/responses, messages, tool calls and results, context, and loop outcomes. Avoid `any`, unsafe casts, and unvalidated external data; validate data at runtime at trust boundaries.
- Keep tools and context pluggable. The core loop must depend on narrow interfaces/contracts, not built-in tools or a particular application context. Applications should be able to register their own tools and supply/build context without modifying the loop.
- Maintain clear separation of concerns. Keep orchestration, model/provider transport, tool registration and execution, context assembly, message/history handling, and shared types independently understandable and testable. Do not let provider-specific or tool-specific details leak into the core loop.
- Do not use AI SDKs, agent frameworks, or similar libraries to implement the model or agent loop. Prefer TypeScript and platform/runtime APIs. Keep dependencies minimal; do not add a library where a small, maintainable implementation will do.
- Favor memory efficiency and low latency: avoid unnecessary copies, repeated serialization, redundant context construction, and needless sequential work. Stream model output where practical, and keep tool execution/concurrency behavior explicit and controllable. Do not trade away correctness or debuggability for speculative optimization.
- Make control flow explicit, including termination, tool-call cycles, errors, cancellation, and configurable limits such as maximum iterations. Prevent malformed model output or tool failures from silently corrupting conversation state.
- Keep the design modular without overengineering. Make public contracts small, document important invariants, and ensure the core can be tested without live provider credentials.

## Implementation guidance
- Before substantial changes, inspect the existing source and identify which types/modules can be reused, simplified, or replaced. Preserve useful project conventions, but do not treat current dependencies or abstractions as requirements.
- Keep provider integration behind a typed adapter boundary. The harness should not be coupled to a single provider; provider-specific wire formats belong in adapters.
- Keep tool definitions, input validation, execution, and result/error representation explicit. Ensure tool inputs arriving from a model are treated as untrusted data.
- Make context assembly replaceable and avoid baking filesystem, shell, or other application policies into the generic loop.
- Prefer small cohesive modules and meaningful names over a monolithic agent implementation.
- Add or update tests and type checks for each substantive change. Cover normal completion, tool-call round trips, malformed tool input, provider/tool errors, cancellation, and iteration limits as applicable. Do not claim checks passed unless they were run.
- Do not make unrelated changes. Discuss consequential architectural tradeoffs and unresolved choices before expanding scope.
