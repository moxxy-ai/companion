import WebSocket from 'ws';
import {
  MOXXY_WS_BEARER_PREFIX,
  MOXXY_WS_SUBPROTOCOL,
  type AskRequest,
  type AskResponse,
  type HistorySegment,
  type MoxxyEvent,
  type RpcNotificationFrame,
  type RpcRequestFrame,
  type RpcResponseFrame,
  type RunTurnArgs,
  type RunTurnResult,
} from '@companion/types';

/**
 * Minimal JSON-RPC-over-WebSocket client for the moxxy gateway.
 *
 * Wire format (mirrors moxxy's JsonRpcPeer):
 *   request      { id, method, params? }
 *   response     { id, result } | { id, error: { message, data? } }
 *   notification { method, params? }
 *
 * Auth rides the subprotocol list: `moxxy.v1, moxxy.bearer.<urlencoded token>`.
 * As a native client we send no Origin header, which passes the gateway's
 * default-deny origin check.
 */

export interface GatewayEvents {
  onEvent?(event: MoxxyEvent): void;
  onTurnComplete?(payload: { workspaceId?: string; turnId?: string }): void;
  onAsk?(ask: AskRequest): void;
  onAskResolved?(payload: { requestId: string }): void;
  onClose?(err?: Error): void;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: GatewayEvents,
  ) {}

  connect(timeoutMs = 10_000): Promise<void> {
    // Boot polling reconnects; never leak a half-open prior socket.
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, [
        MOXXY_WS_SUBPROTOCOL,
        `${MOXXY_WS_BEARER_PREFIX}${encodeURIComponent(this.token)}`,
      ]);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('gateway connect timeout'));
      }, timeoutMs);

      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('message', (data) => this.onFrame(String(data)));
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on('close', () => {
        clearTimeout(timer);
        this.failAllPending(new Error('gateway connection closed'));
        if (!this.closed) this.handlers.onClose?.();
      });
    });
  }

  close(): void {
    this.closed = true;
    this.failAllPending(new Error('gateway client closed'));
    this.ws?.close();
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---------- typed command surface -----------------------------------------

  async runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
    return (await this.request('session.runTurn', args)) as RunTurnResult;
  }

  async abortTurn(turnId?: string): Promise<void> {
    await this.request('session.abortTurn', { turnId });
  }

  async sessionInfo(): Promise<unknown> {
    return this.request('session.info', undefined);
  }

  async setMode(mode: string): Promise<void> {
    await this.request('session.setMode', { mode });
  }

  /** Session-side model override (null resets to the provider default). */
  async setModel(model: string | null): Promise<void> {
    await this.request('session.setModel', { model });
  }

  async setProvider(provider: string): Promise<void> {
    await this.request('session.setProvider', { provider });
  }

  async setAutoApprove(enabled: boolean): Promise<void> {
    await this.request('session.setAutoApprove', { enabled });
  }

  async runCommand(name: string, args?: string): Promise<unknown> {
    return this.request('session.runCommand', { name, args });
  }

  async respondAsk(requestId: string, response: AskResponse): Promise<void> {
    await this.request('ask.respond', { requestId, response });
  }

  async loadHistory(
    workspaceId: string,
    before: number | null,
    limit: number,
  ): Promise<HistorySegment> {
    const result = await this.request('chat.loadHistory', { workspaceId, before, limit });
    if (result && typeof result === 'object' && Array.isArray((result as HistorySegment).events)) {
      return result as HistorySegment;
    }
    return { events: [], prevCursor: null };
  }

  // ---------- wire ------------------------------------------------------------

  private request(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`gateway not connected (${method})`));
    }
    const id = this.nextId++;
    const frame: RpcRequestFrame = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(frame), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private onFrame(raw: string): void {
    let frame: RpcResponseFrame | RpcNotificationFrame;
    try {
      frame = JSON.parse(raw) as RpcResponseFrame | RpcNotificationFrame;
    } catch {
      return; // never crash on a garbled frame
    }
    if (typeof (frame as RpcResponseFrame).id === 'number') {
      const res = frame as RpcResponseFrame;
      const entry = this.pending.get(res.id);
      if (!entry) return;
      this.pending.delete(res.id);
      clearTimeout(entry.timer);
      if (res.error) entry.reject(new Error(res.error.message));
      else entry.resolve(res.result);
      return;
    }
    const note = frame as RpcNotificationFrame;
    if (typeof note.method !== 'string') return;
    this.dispatchNotification(note.method, note.params);
  }

  private dispatchNotification(channel: string, params: unknown): void {
    try {
      switch (channel) {
        case 'runner.event': {
          const event = (params as { event?: MoxxyEvent })?.event;
          if (event && typeof event.type === 'string') this.handlers.onEvent?.(event);
          break;
        }
        case 'runner.turn.complete':
          this.handlers.onTurnComplete?.((params ?? {}) as { workspaceId?: string; turnId?: string });
          break;
        case 'ask.request': {
          const ask = params as AskRequest;
          if (ask && typeof ask.requestId === 'string') this.handlers.onAsk?.(ask);
          break;
        }
        case 'ask.resolved': {
          const p = params as { requestId?: string };
          if (typeof p?.requestId === 'string') this.handlers.onAskResolved?.({ requestId: p.requestId });
          break;
        }
        default:
          break; // connection.changed etc. — not needed yet; unknown channels tolerated
      }
    } catch {
      // a handler throwing must not kill the socket read loop
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
