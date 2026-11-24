/**
 * Every user-visible message raised or emitted by vyper.
 *
 * Keep message formatting here rather than at call sites. Static messages are
 * plain strings; messages with runtime data are small functions so the
 * formatting stays consistent and easy to review.
 */

const MAX_PROVIDER_DETAIL_LENGTH = 2_000;

export const ERROR_MESSAGES = {
  // Configuration and environment
  configuration: {
    missingApiKey: (variable: string): string =>
      `${variable} is not set. Add it to .env first.`,
  },

  // Agent loop
  agent: {
    optionsMustBeObject: "AgentOptions must be an object",
    modelMustProvideGenerate: "AgentOptions.model must provide generate()",
    contextMustProvideHooks:
      "AgentOptions.context must provide prepare() and observe()",
    toolsMustProvideCatalog:
      "AgentOptions.tools must provide get() and list()",
    instructionsMustBeString: "AgentOptions.instructions must be a string",
    cwdMustBeNonEmptyString: "AgentOptions.cwd must be a non-empty string",
    onEventMustBeFunction: "AgentOptions.onEvent must be a function",
    onEventErrorMustBeFunction:
      "AgentOptions.onEventError must be a function",
    interceptorsMustBeFunctions:
      "Agent interceptors must be an array of functions",
    maxStepsMustBePositiveInteger:
      "AgentOptions.maxSteps must be a positive integer",
    inputMustBeStringOrMessages:
      "Agent input must be a string or an array of messages",
    runOptionsMustBeObject: "AgentRunOptions must be an object",
    runOnEventMustBeFunction: "AgentRunOptions.onEvent must be a function",
    duplicateTool: (name: string): string =>
      `Duplicate tool in catalog: ${name}`,
    finalStepRequestedTools:
      "Model requested tools on the final, tool-free step",
    deferContextRequiresUserMessage:
      "deferContext() requires a user message with string content",
    toolExecutionFailed: (detail: string): string =>
      `Tool execution failed: ${detail}`,
    missingToolResult: "Tool execution returned no result for this call.",
    maxStepsReached: (maxSteps: number): string =>
      `Maximum steps reached (${maxSteps}).`,
    runAborted: "Run aborted.",
  },

  // Conversation and tool-call validation
  conversation: {
    messageMustBeObject: (index: number): string =>
      `messages[${index}] must be an object`,
    systemMessage: (index: number): string =>
      `messages[${index}] must not be a system message; pass instructions via AgentOptions.instructions`,
    contentMustBeString: (index: number): string =>
      `messages[${index}].content must be a string`,
    contentMustBeStringWhenPresent: (index: number): string =>
      `messages[${index}].content must be a string when present`,
    toolCallIdMustBeNonEmptyString: (index: number): string =>
      `messages[${index}].toolCallId must be a non-empty string`,
    roleInvalid: (index: number): string =>
      `messages[${index}].role is invalid`,
    messageMissing: (index: number): string =>
      `messages[${index}] is missing`,
    orphanToolMessage: (index: number): string =>
      `messages[${index}] is an orphan tool message`,
    assistantMustContainContent: (index: number): string =>
      `messages[${index}] assistant message must contain text or tool calls`,
    duplicateToolCallId: (id: string): string =>
      `Duplicate tool call id in conversation: ${id}`,
    missingToolResult: (index: number, callId: string): string =>
      `messages[${index}] is missing; expected a tool result for call ${callId}`,
    expectedToolResult: (index: number, callId: string): string =>
      `messages[${index}] must be a tool result for call ${callId}`,
    toolCallIdMismatch: (
      index: number,
      expected: string,
      received: string,
    ): string =>
      `messages[${index}].toolCallId must be ${expected}, received ${received}`,
    missingToolCall: (index: number, offset: number): string =>
      `messages[${index}].toolCalls[${offset}] is missing`,
  },

  toolCalls: {
    mustBeArray: (label: string): string => `${label} must be an array`,
    mustBeObject: (label: string): string => `${label} must be an object`,
    idMustBeNonEmptyString: (label: string): string =>
      `${label}.id must be a non-empty string`,
    nameMustBeNonEmptyString: (label: string): string =>
      `${label}.name must be a non-empty string`,
    argumentsMustBeObject: (label: string): string =>
      `${label}.arguments must be an object`,
    duplicateId: (id: string): string => `Duplicate tool call id: ${id}`,
  },

  // Model and context boundaries
  modelResponse: {
    mustBeObject: "Model response must be an object",
    textMustBeString: "Model response text must be a string when present",
    mustContainTextOrToolCalls:
      "Model response must contain text or tool calls",
    usageMustBeNonNegative:
      "Model response usage must contain non-negative inputTokens and outputTokens",
    streamChunkMustBeObject: "Model stream chunk must be an object",
    streamChunkTypeInvalid: (type: string): string =>
      `Model stream chunk type is unknown: ${type}`,
    streamTextDeltaMustBeString:
      "Model stream text delta must contain a string text field",
    streamToolCallIdMustBeNonEmptyString:
      "Model stream tool call delta must contain a non-empty toolCallId",
    streamToolCallDeltaMustBeString:
      "Model stream tool call delta fields must be strings when present",
    streamToolCallDoneInvalid:
      "Model stream tool call done chunk must contain a valid tool call",
    streamUsageInvalid:
      "Model stream usage chunk must contain non-negative inputTokens and outputTokens",
    streamToolCallArgumentsInvalid: (id: string, detail: string): string =>
      `Model stream tool call ${id} has invalid JSON arguments: ${detail}`,
  },

  context: {
    invalidPreparedContext:
      "ContextManager.prepare() returned an invalid PreparedContext",
    systemPromptMustBeString:
      "ContextManager.prepare() returned a non-string system prompt",
    invalidMessages: (detail: string): string =>
      `ContextManager.prepare() returned invalid messages: ${detail}`,
  },

  // Tools
  tools: {
    argumentsMustBeObject: "Arguments must be an object",
    executionCancelled: "Tool execution cancelled",
    pathMustBeNonEmptyString: "path must be a non-empty string",
    offsetMustBePositiveInteger: "offset must be a positive integer",
    limitMustBePositiveInteger: "limit must be a positive integer",
    pathOutsideWorkingDirectory:
      "Path must stay inside the working directory",
    patternMustBeString: "pattern must be a string",
    pathMustBeString: "path must be a string",
    globMustBeString: "glob must be a string",
    invalidRegularExpression: (detail: string): string =>
      `Invalid regular expression: ${detail}`,
    commandMustBeNonEmptyString: "command must be a non-empty string",
    commandRequiresApproval:
      "Command requires approval or is not in the automatic allowlist",
    commandFailed: (
      exitCode: number | string | undefined,
      output: string,
      fallback: string,
    ): string => {
      const status = exitCode === undefined ? "" : ` (exit ${exitCode})`;
      const detail = output.length > 0 ? `:\n${output}` : `: ${fallback}`;
      return `Command failed${status}${detail}`;
    },
  },

  toolDefinition: {
    mustBeObject: "Tool definition must be an object",
    invalidName: (label: string, pattern: RegExp): string =>
      `Invalid ${label} name: expected 1-64 characters matching ${pattern}`,
    descriptionMustBeNonEmptyString: (label: string): string =>
      `Invalid ${label}: description must be a non-empty string`,
    parametersMustBeSchemaObject: (label: string): string =>
      `Invalid ${label}: parameters must be a JSON schema object`,
    parametersTypeMustBeObject: (label: string): string =>
      `Invalid ${label}: parameters.type must be "object"`,
    parametersMustBeValidSchema: (label: string): string =>
      `Invalid ${label}: parameters and nested properties must be valid JSON schemas`,
    propertiesMustBeObject: (label: string): string =>
      `Invalid ${label}: parameters.properties must be an object`,
    parameterNamesMustNotBeEmpty: (label: string): string =>
      `Invalid ${label}: parameter names must not be empty`,
    requiredMustBeStringArray: (label: string): string =>
      `Invalid ${label}: parameters.required must be an array of non-empty strings`,
    additionalPropertiesMustBeBoolean: (label: string): string =>
      `Invalid ${label}: parameters.additionalProperties must be a boolean`,
    parseMustBeFunction: (label: string): string =>
      `Invalid ${label}: parse must be a function`,
    executeMustBeFunction: (label: string): string =>
      `Invalid ${label}: execute must be a function`,
    renderMustBeFunction: (label: string): string =>
      `Invalid ${label}: render must be a function`,
  },

  toolRegistry: {
    alreadyRegistered: (name: string): string =>
      `Tool already registered: ${name}`,
  },

  toolDiscovery: {
    optionsMustBeObject: "ToolDiscoveryOptions must be an object",
  },

  executor: {
    timeoutMustBePositiveNumber: "timeoutMs must be a positive number",
    maxResultCharsMustBePositiveInteger:
      "maxResultChars must be a positive integer",
    concurrencyMustBePositiveInteger:
      "concurrency must be a positive integer",
    catalogMustProvideGetAndList:
      "Tool catalog must provide get() and list()",
    unknownTool: (name: string): string => `Unknown tool: ${name}`,
    invalidArguments: (name: string, detail: string): string =>
      `Invalid arguments for ${name}: ${detail}`,
    timedOut: (timeoutMs?: number): string => {
      if (timeoutMs === undefined) return "Tool execution timed out";
      return `Tool execution timed out after ${timeoutMs} ms`;
    },
    failed: (name: string, detail: string): string =>
      `Tool ${name} failed: ${detail}`,
    renderFailed: (name: string, detail: string): string =>
      `Tool ${name} failed to render its result: ${detail}`,
    renderMustReturnString: (name: string): string =>
      `Tool ${name} render() must return a string`,
  },

  // Event log and session persistence
  eventLog: {
    invalidRecord: (detail: string): string =>
      `Invalid event log record: ${detail}`,
    poisoned: (detail: string): string =>
      `Event log handle is poisoned: ${detail}`,
    readAfterFailure: "Cannot read an event log after a write failure",
    streamLocked: (streamId: string): string =>
      `Event log stream "${streamId}" is already open by another writer`,
  },

  sessionLog: {
    missingHeader: "Session log must start with a header at sequence 1",
    headerMustBeFirst: "Session header must be sequence 1",
    headerImmutable: "Session header cannot be rewritten or appended twice",
    metadataMustChange: "MetadataChanged must change at least one field",
    turnFinishedMismatch: (
      turnId: string,
      field: string,
      expected: string,
      received: string,
    ): string =>
      `TurnFinished for ${turnId} has ${field}=${received}; recorded events require ${expected}`,
    retractionTargetMissing: (sequence: number): string =>
      `Retraction target sequence ${sequence} does not exist`,
    retractionTargetInvalid: (sequence: number): string =>
      `Sequence ${sequence} cannot be retracted`,
    retractionTargetAlreadyRetracted: (sequence: number): string =>
      `Sequence ${sequence} was already retracted`,
    compactionCutoffInvalid: (cutoff: number, sequence: number): string =>
      `Compaction cutoff ${cutoff} must be below its own sequence ${sequence}`,
    turnAlreadyFinished: (turnId: string): string =>
      `Turn ${turnId} already has a TurnFinished record`,
  },

  sessionRecorder: {
    turnAlreadyActive: "A session turn is already being recorded",
    noActiveTurn: "No session turn is being recorded",
    recordingFailed: (detail: string): string =>
      `Session event recording failed: ${detail}`,
  },

  chat: {
    turnInProgress: "A chat turn is already in progress",
    resetWhileRunning: "Cannot reset a chat session while a turn is running",
    resetInProgress: "A chat session reset is already in progress",
    closeWhileRunning: "Cannot close a chat session while a turn is running",
    closeWhileResetting: "Cannot close a chat session while it is resetting",
  },

  // Provider adapters
  gemini: {
    missingToolResultMapping: (toolCallId: string): string =>
      `Cannot map tool result ${toolCallId} to a function call`,
    nonObjectResponse: "Gemini returned a non-object response",
    noCandidates: (blockReason?: string): string => {
      const blocked =
        blockReason === undefined ? "" : ` (blocked: ${blockReason})`;
      return `Gemini returned no candidates${blocked}`;
    },
    malformedCandidate: "Gemini returned a malformed candidate",
    functionCallMissingName: "Gemini function call is missing a name",
    functionCallArgumentsNotObject: (name: string): string =>
      `Gemini function call ${name} has non-object arguments`,
    emptyResponse: (finishReason: string): string =>
      `Gemini returned an empty response (finishReason: ${finishReason})`,
    requestFailed: (
      status: number,
      statusText: string,
      detail: string,
    ): string => {
      const summary = `Gemini request failed (${status} ${statusText})`;
      const trimmed = detail.trim();
      if (trimmed.length === 0) return summary;
      return `${summary}: ${trimmed.slice(0, MAX_PROVIDER_DETAIL_LENGTH)}`;
    },
  },
} as const;
