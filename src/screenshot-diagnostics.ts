// Passive diagnostics for the one CDP command behind page screenshots. Do not
// log request parameters, response data, page URLs or CDP error messages: a
// screenshot response contains the image itself.
type Timer = ReturnType<typeof setTimeout>;
type Clock = {
  now: () => number;
  after: (fn: () => void, ms: number) => Timer;
  cancel: (timer: Timer) => void;
};

const realClock: Clock = {
  now: () => performance.now(),
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  cancel: timer => clearTimeout(timer),
};

type Pending = {
  label: string;
  started: number;
  slow: Timer;
  noReply: Timer;
  forget: Timer;
};

export class ScreenshotDiagnostics {
  private _pending = new Map<string, Pending>();
  private _sequence = 0;
  private readonly _session: string;
  private readonly _log: (line: string) => void;
  private readonly _clock: Clock;
  private readonly _slowMs: number;
  private readonly _noReplyMs: number;
  private readonly _forgetMs: number;

  constructor(options: {
    session: string;
    log: (line: string) => void;
    clock?: Clock;
    slowMs?: number;
    noReplyMs?: number;
    forgetMs?: number;
  }) {
    this._session = options.session;
    this._log = options.log;
    this._clock = options.clock ?? realClock;
    this._slowMs = options.slowMs ?? 5_000;
    this._noReplyMs = options.noReplyMs ?? 35_000;
    this._forgetMs = options.forgetMs ?? 300_000;
  }

  private _key(sessionId: string, id: number) {
    return `${sessionId}:${id}`;
  }

  private _clear(entry: Pending) {
    this._clock.cancel(entry.slow);
    this._clock.cancel(entry.noReply);
    this._clock.cancel(entry.forget);
  }

  start(sessionId: string, id: number, targetId: string | undefined, window: 'visible' | 'hidden' | 'unknown') {
    const key = this._key(sessionId, id);
    const old = this._pending.get(key);
    if (old) {
      this._clear(old);
      this._log(`${old.label} Page.captureScreenshot replaced before reply`);
    }
    const label = `screenshot session=${this._session} call=${++this._sequence}`;
    const entry = { label, started: this._clock.now() } as Pending;
    this._pending.set(key, entry);
    entry.slow = this._clock.after(() => {
      if (this._pending.get(key) === entry)
        this._log(`${label} Page.captureScreenshot waiting after ${this._slowMs} ms`);
    }, this._slowMs);
    entry.noReply = this._clock.after(() => {
      if (this._pending.get(key) !== entry) return;
      this._log(`${label} Page.captureScreenshot no reply after ${this._noReplyMs} ms`);
    }, this._noReplyMs);
    entry.forget = this._clock.after(() => {
      if (this._pending.get(key) !== entry) return;
      this._pending.delete(key);
      this._clear(entry);
      this._log(`${label} Page.captureScreenshot forgotten after ${this._forgetMs} ms without reply`);
    }, this._forgetMs);
    this._log(`${label} Page.captureScreenshot sent tab=${targetId?.slice(0, 8) ?? '?'} window=${window}`);
  }

  finish(sessionId: string, id: number, error?: { code?: number; message?: string }): boolean {
    const key = this._key(sessionId, id);
    const entry = this._pending.get(key);
    if (!entry) return false;
    this._pending.delete(key);
    this._clear(entry);
    const ms = Math.round(this._clock.now() - entry.started);
    this._log(`${entry.label} Page.captureScreenshot reply after ${ms} ms ${error ? `error=${error.code ?? 'unknown'}` : 'ok'}`);
    return true;
  }

  close() {
    for (const entry of this._pending.values()) {
      this._clear(entry);
      const ms = Math.round(this._clock.now() - entry.started);
      this._log(`${entry.label} Page.captureScreenshot connection closed after ${ms} ms without reply`);
    }
    this._pending.clear();
  }
}
