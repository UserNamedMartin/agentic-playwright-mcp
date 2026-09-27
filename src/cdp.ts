// A raw Chrome DevTools Protocol connection over WebSocket (flat sessions).
// The gateway talks to the browser through one of these (see browser.ts), and
// every agent session's Playwright gets its own one behind the proxy (see
// proxy.ts). Playwright's own connection classes are internal, and the proxy
// needs the messages as they are anyway.
import { ws as WebSocket } from './internals.js';

export type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string }; sessionId?: string };

// Calls the browser never answers must not wait forever (a stalled
// connection): they fail after this long unless the caller says otherwise.
const defaultTimeoutMs = 30_000;

export class CdpConnection {
  private _ws: any;
  private _lastId = 0;
  private _pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; method: string; timer: NodeJS.Timeout }>();
  private _closed = false;
  // Events, and answers to messages sent with sendRaw.
  onMessage: (message: CdpMessage) => void = () => {};
  onClose: () => void = () => {};

  private constructor(ws: any) {
    this._ws = ws;
    ws.on('message', (data: Buffer) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const pending = message.id !== undefined ? this._pending.get(message.id) : undefined;
      if (pending) {
        this._pending.delete(message.id!);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else
          pending.resolve(message.result);
        return;
      }
      this.onMessage(message);
    });
    ws.on('close', () => this._onClose());
    ws.on('error', () => {});
  }

  static async connect(url: string, timeoutMs = 15_000): Promise<CdpConnection> {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Could not connect to ${url} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
    return new CdpConnection(ws);
  }

  // The browser-level WebSocket address of a DevTools HTTP endpoint.
  static async browserUrl(cdpEndpoint: string): Promise<string> {
    const res = await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(5000) });
    const { webSocketDebuggerUrl } = await res.json() as { webSocketDebuggerUrl: string };
    return webSocketDebuggerUrl;
  }

  get closed() {
    return this._closed;
  }

  send<T = any>(method: string, params: any = {}, sessionId?: string, timeoutMs = defaultTimeoutMs): Promise<T> {
    if (this._closed)
      return Promise.reject(new Error(`${method}: the browser connection is closed`));
    // Our ids stay clear of the ones a proxied client uses (sendRaw).
    const id = 1_000_000_000 + ++this._lastId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method}: the browser did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, method, timer });
      this._ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  // A message passed through as it is; its answer arrives in onMessage.
  sendRaw(message: CdpMessage) {
    if (!this._closed)
      this._ws.send(JSON.stringify(message));
  }

  close() {
    this._ws.close();
    this._onClose();
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: the browser connection closed`));
      this._pending.delete(id);
    }
    this.onClose();
  }
}
