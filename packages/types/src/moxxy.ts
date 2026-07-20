/**
 * Hand-declared subset of the moxxy wire contract.
 *
 * moxxy is an EXTERNAL runtime: Companion never imports `@moxxy/*` packages.
 * These types mirror the shapes moxxy's gateway (`moxxy mobile --standalone`)
 * puts on the wire. They are intentionally permissive — every inbound message
 * is treated as untrusted and runtime-checked where it matters, so a newer
 * moxxy adding fields (or event types we don't know) must never crash us.
 *
 * Mirrored from (reference only):
 *   - packages/sdk/src/events.ts            (MoxxyEvent union)
 *   - packages/desktop-ipc-contract/src/    (commands, ask, chat)
 *   - packages/runner/src/jsonrpc.ts        (frame shapes)
 */

// ---------- JSON-RPC frames (the whole wire format) -------------------------

export interface RpcRequestFrame {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcResponseFrame {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly data?: unknown };
}

export interface RpcNotificationFrame {
  readonly method: string;
  readonly params?: unknown;
}

/** Subprotocols the gateway expects on `Sec-WebSocket-Protocol`. */
export const MOXXY_WS_SUBPROTOCOL = 'moxxy.v1';
export const MOXXY_WS_BEARER_PREFIX = 'moxxy.bearer.';

// ---------- Events (the stream a session emits) -----------------------------

/** Known event discriminators. Unknown types must be tolerated (rendered as opaque). */
export type MoxxyEventType =
  | 'user_prompt'
  | 'assistant_chunk'
  | 'assistant_message'
  | 'reasoning_chunk'
  | 'reasoning_message'
  | 'tool_call_requested'
  | 'tool_call_approved'
  | 'tool_call_denied'
  | 'tool_result'
  | 'skill_invoked'
  | 'skill_created'
  | 'plugin_registered'
  | 'plugin_unregistered'
  | 'mode_iteration'
  | 'compaction'
  | 'elision'
  | 'provider_request'
  | 'provider_response'
  | 'error'
  | 'abort'
  | 'plugin_event'
  | (string & {});

export interface MoxxyEventBase {
  readonly id: string;
  readonly seq: number;
  readonly ts: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly causationId?: string;
  readonly source: string;
  readonly type: MoxxyEventType;
}

export interface UserPromptEvent extends MoxxyEventBase {
  readonly type: 'user_prompt';
  readonly text: string;
  readonly attachments?: ReadonlyArray<{
    readonly kind: string;
    readonly content: string;
    readonly name?: string;
    readonly mediaType?: string;
  }>;
  readonly origin?: { readonly kind: 'webhook' | 'schedule' | 'workflow'; readonly name: string };
}

export interface AssistantChunkEvent extends MoxxyEventBase {
  readonly type: 'assistant_chunk';
  readonly delta: string;
}

export interface AssistantMessageEvent extends MoxxyEventBase {
  readonly type: 'assistant_message';
  readonly content: string;
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
}

export interface ReasoningChunkEvent extends MoxxyEventBase {
  readonly type: 'reasoning_chunk';
  readonly delta: string;
}

export interface ReasoningMessageEvent extends MoxxyEventBase {
  readonly type: 'reasoning_message';
  readonly content: string;
  readonly redacted?: boolean;
}

export interface ToolCallRequestedEvent extends MoxxyEventBase {
  readonly type: 'tool_call_requested';
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolCallApprovedEvent extends MoxxyEventBase {
  readonly type: 'tool_call_approved';
  readonly callId: string;
  readonly decidedBy: string;
  readonly mode: string;
}

export interface ToolCallDeniedEvent extends MoxxyEventBase {
  readonly type: 'tool_call_denied';
  readonly callId: string;
  readonly decidedBy: string;
  readonly reason: string;
}

export interface ToolResultEvent extends MoxxyEventBase {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: { readonly message: string; readonly kind: string };
}

export interface ProviderResponseEvent extends MoxxyEventBase {
  readonly type: 'provider_response';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface ErrorEvent extends MoxxyEventBase {
  readonly type: 'error';
  readonly message?: string;
  readonly kind?: string;
}

export interface AbortEvent extends MoxxyEventBase {
  readonly type: 'abort';
}

export interface PluginEventEvent extends MoxxyEventBase {
  readonly type: 'plugin_event';
  readonly pluginId?: string;
  readonly subtype?: string;
  readonly payload?: unknown;
}

/** Any event off the wire. Narrow via the `type` discriminator; tolerate unknowns. */
export type MoxxyEvent =
  | UserPromptEvent
  | AssistantChunkEvent
  | AssistantMessageEvent
  | ReasoningChunkEvent
  | ReasoningMessageEvent
  | ToolCallRequestedEvent
  | ToolCallApprovedEvent
  | ToolCallDeniedEvent
  | ToolResultEvent
  | ProviderResponseEvent
  | ErrorEvent
  | AbortEvent
  | PluginEventEvent
  | (MoxxyEventBase & { readonly [key: string]: unknown });

// ---------- Ask (permission / approval prompts) ------------------------------

export type PermissionMode = 'allow' | 'allow_session' | 'allow_always' | 'deny';

export interface AskRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly kind: 'permission' | 'approval' | 'workflow';
  readonly tool?: { readonly name: string; readonly input: unknown; readonly description?: string };
  readonly approval?: {
    readonly title?: string;
    readonly body?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly [key: string]: unknown;
  };
  readonly workflow?: {
    readonly runId: string;
    readonly workflow: string;
    readonly stepId: string;
    readonly label: string;
    readonly prompt: string;
  };
}

export interface AskResponse {
  readonly mode?: PermissionMode;
  readonly optionId?: string;
  readonly text?: string;
}

// ---------- Gateway commands Companion invokes -------------------------------

export interface PromptAttachment {
  readonly kind: 'image';
  /** Base64 bytes, without a data-URL prefix. */
  readonly content: string;
  readonly name?: string;
  readonly mediaType: string;
}

export interface RunTurnArgs {
  readonly prompt: string;
  readonly model?: string;
  readonly attachments?: readonly PromptAttachment[];
}

export interface RunTurnResult {
  readonly turnId: string;
}

export interface LoadHistoryArgs {
  readonly workspaceId?: string;
  readonly before?: number | null;
  readonly limit?: number;
}

export interface HistorySegment {
  readonly events: ReadonlyArray<MoxxyEvent>;
  readonly prevCursor: number | null;
}

/** Gateway event notification channels Companion subscribes to. */
export type GatewayEventChannel =
  | 'runner.event'
  | 'runner.turn.started'
  | 'runner.turn.complete'
  | 'connection.changed'
  | 'ask.request'
  | 'ask.resolved';
