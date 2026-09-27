// One agent session = one chat (or subagent). Its Playwright (a stock
// Playwright MCP backend on a connection of its own through the proxy, see
// proxy.ts) runs in a worker thread (worker.ts), so code one agent runs cannot
// stall the gateway or other chats: a thread that stops answering is ended
// and started again, and the session's tabs stay. This side adds the
// gateway's behavior around the calls: one call at a time with a timeout,
// notes for the agent, files in the session's folder, and routes, offline mode
// and device emulation kept across new threads, reconnects and restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SharedBrowser } from './browser.js';
import type { TabGroups } from './groups.js';
import type { CdpProxy } from './proxy.js';
import { touchFolder } from './files.js';
import type { Emulation } from './tools.js';
import { internalUrl } from './urls.js';
import { loadProfiles } from './profiles.js';
import { describePasskeyRequests, type PasskeyRequest } from './passkeys.js';
import type { PermissionRequest } from './permissions.js';
import type { CallOutcome, FromWorker, ToWorker, WorkerStart } from './worker.js';

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

// A tool call is given up after this long unless the agent passes "timeout"
// (seconds); browser_wait_for gets its own wait time on top.
export const defaultCallTimeoutSeconds = 120;
const maxTimeoutSeconds = Math.floor((2 ** 31 - 1) / 1000);
// A call that waited at least this long behind the previous one says so.
const queueNoteMs = 2000;

export function callTimeoutSeconds(name: string, args: any, timeout: unknown) {
  const asked = Number(timeout);
  // setTimeout takes at most 2^31-1 ms (about 24 days).
  if (Number.isFinite(asked) && asked > 0)
    return Math.min(asked, maxTimeoutSeconds);
  const waitFor = name === 'browser_wait_for' ? Number(args?.time) || 0 : 0;
  return defaultCallTimeoutSeconds + waitFor;
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text: `### Error\n${text}` }], isError: true };
}

export type SessionInfo = {
  id: string;
  // Tab group title; kept in sync with the chat's title (see Gateway._refreshTitle).
  title: string;
  pid?: number;
  cwd?: string;
  claudeSessionId?: string;
  configDir?: string;
  // Claude desktop app chat id, to look the current title up.
  desktopChat?: string;
  // Subagents: their task, shown after the chat title.
  label?: string;
  // The title the client sent, used when no better one is known.
  fallbackTitle?: string;
};

// What a session needs from the gateway. The browser connection is replaced
// when the gateway reconnects, so sessions always look it up.
export type SessionHost = {
  readonly shared: SharedBrowser;
  readonly groups: TabGroups | undefined;
  readonly proxy: CdpProxy;
  // Creates (or finds again) the session's files folder.
  filesFolder(session: AgentSession): string;
  onSessionStarted(session: AgentSession): void;
  onTabsChanged(): void;
  // Permission requests of the session's pages the agent should hear about.
  permissionNotes(session: AgentSession): string | undefined;
  // A forked chat's first start: copies of the original chat's tabs, owned by
  // the session; resolves to a note for the agent, if there were any.
  copyForkedTabs(session: AgentSession): Promise<string | undefined>;
  // The tabs of the session's subagents, listed in its browser_tabs results.
  subagentTabs(session: AgentSession): string | undefined;
  // Ports of addresses agents may not open (see urls.ts).
  internalPorts(): string[];
  // What the session's tools ask of the gateway (see ToolHost in tools.ts).
  answerPermissions(session: AgentSession, decision: 'allow' | 'deny', names: string[] | undefined, origin: string | undefined, currentUrl: string | undefined): Promise<string>;
};

export type SavedNetworkState = {
  offline: boolean;
  routes: any[];
  emulation: [string, Emulation][];
  lostRoutes: boolean;
  tracing?: boolean;
  recording?: boolean;
};

let knownPorts: { at: number; ports: string[] } | undefined;

// Every profile's gateway and DevTools ports (other profiles may run too).
export function profilePorts() {
  if (!knownPorts || Date.now() - knownPorts.at > 10_000) {
    let ports: string[] = [];
    try {
      ports = loadProfiles().flatMap(p => [String(p.port), String(p.cdpPort)]);
    } catch {}
    knownPorts = { at: Date.now(), ports };
  }
  return knownPorts.ports;
}

// Things a dropped connection or a restart ends, with what the agent is told.
const lostOnReconnect: Record<string, string> = {
  video: '### Video\nThe video recording stopped: the browser connection dropped and was restored. Start it again if you still need it.',
  recording: '### Recording\nThe action recording stopped: the browser connection dropped and was restored. Start it again if you still need it.',
  tracing: '### Tracing\nTracing stopped: the browser connection dropped and was restored. Start it again if you still need it.',
};

// A thread that does not answer a ping for this long while a call runs is
// stuck (a busy loop in an agent's code) and is ended.
const stuckMs = 10_000;
const pingMs = 2_000;
// A thread with nothing to do for this long is ended (it is started again on
// the next call); its memory is the session's biggest cost.
const idleMs = 10 * 60 * 1000;

// A running worker thread and what is waiting on it.
type Thread = {
  worker: Worker;
  ready: Promise<void>;
  calls: Map<number, (message: FromWorker & { type: 'result' }) => void>;
  queries: Map<number, (message: FromWorker & { type: 'tab' }) => void>;
  lastPong: number;
  ended: boolean;
  // Ended because it stopped answering (not because the connection dropped).
  stuck?: boolean;
};

export class AgentSession {
  readonly info: SessionInfo;
  lastActivity = Date.now();
  subagentCount = 0;
  permissionRequests: PermissionRequest[] = [];
  // Passkey requests of the session's pages not yet told to the agent.
  passkeyRequests: PasskeyRequest[] = [];
  // A session exists from the moment its chat connects; it counts as started
  // (log line, files folder, tab group) only once it uses the browser.
  started = false;
  startedAt = 0;
  // Everything this session saves goes here (see files.ts); set on start.
  filesDir: string | undefined;
  // Target id of the current tab, remembered across threads and restarts.
  currentTarget: string | undefined;
  private _currentUrl: string | undefined;
  private _thread: Thread | undefined;
  private _host: SessionHost;
  private _config: any;
  private _filesNoted = false;
  // Told to the agent in the next tool result.
  private _notes: string[] = [];
  private _touchedAt = 0;
  private _retentionDays: number;
  // Kept here, not only in the thread, to be set up again on a new one.
  private _routes: any[] = [];
  private _lostRoutes = false;
  private _codeRoutes = false;
  offline = false;
  // Device emulation by tab (target id), see browser_emulate_device.
  emulation = new Map<string, Emulation>();
  // Started by the agent and not stopped yet: ended with the thread.
  private _running = new Set<'video' | 'recording' | 'tracing'>();
  private _lastId = 0;
  private _idleTimer: NodeJS.Timeout | undefined;

  constructor(info: SessionInfo, host: SessionHost, config: any, _tools: any[], retentionDays = 7) {
    this.info = info;
    this._host = host;
    this._retentionDays = retentionDays;
    this._config = config;
  }

  // The session's tabs (target ids).
  get targets(): Set<string> {
    const targets = new Set<string>();
    for (const [targetId, owner] of this._host.shared?.owners ?? [])
      if (owner === this.info.id)
        targets.add(targetId);
    return targets;
  }

  ensureFilesDir(): string {
    if (!this.filesDir) {
      this.filesDir = this._host.filesFolder(this);
      fs.mkdirSync(this.filesDir, { recursive: true });
    }
    return this.filesDir;
  }

  get internalPorts() {
    return this._host.internalPorts();
  }

  // Whether the session's Playwright is running (a thread with a connection).
  get running() {
    return !!this._thread;
  }

  private async _start() {
    const first = !this.started;
    if (first) {
      this.started = true;
      this._host.onSessionStarted(this);
    }
    const filesDir = this.ensureFilesDir();
    // A forked chat starts with copies of the original chat's tabs.
    if (first && !this.targets.size) {
      const note = await this._host.copyForkedTabs(this).catch(e => `### Tabs of the original chat\nCould not copy them: ${(e as Error).message}`);
      if (note)
        this._notes.push(note);
    }
    const start: WorkerStart = {
      endpoint: this._host.proxy.endpoint(this.info.id),
      config: this._config,
      filesDir,
      title: this.info.title,
      internalPorts: this._host.internalPorts(),
      routes: this._routes,
      offline: this.offline,
      emulation: [...this.emulation],
      currentTarget: this.currentTarget,
    };
    const worker = new Worker(workerFile, { workerData: start, stdout: false, stderr: false });
    const thread: Thread = { worker, ready: undefined as any, calls: new Map(), queries: new Map(), lastPong: Date.now(), ended: false };
    thread.ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (message: FromWorker) => {
        if (message.type === 'ready')
          resolve();
        else if (message.type === 'failed')
          reject(new Error(message.error));
        else
          this._onMessage(thread, message);
      });
      worker.on('error', error => {
        console.error(`${this.info.title}: browser thread failed: ${error.stack ?? error}`);
        reject(error);
      });
      worker.on('exit', () => {
        this._ended(thread, 'The browser session\'s thread ended.');
        reject(new Error('The browser session\'s thread ended while starting.'));
      });
    });
    this._thread = thread;
    try {
      await thread.ready;
    } catch (e) {
      this._endThread(thread);
      throw e;
    }
  }

  private _onMessage(thread: Thread, message: FromWorker) {
    switch (message.type) {
      case 'result':
        thread.calls.get(message.id)?.(message);
        thread.calls.delete(message.id);
        return;
      case 'tab':
        thread.queries.get(message.id)?.(message);
        thread.queries.delete(message.id);
        return;
      case 'pong':
        thread.lastPong = Date.now();
        return;
      case 'rpc':
        void this._rpc(message.method, message.args).then(
            value => thread.worker.postMessage({ type: 'reply', id: message.id, value } satisfies ToWorker),
            error => thread.worker.postMessage({ type: 'reply', id: message.id, error: String((error as Error).message ?? error) } satisfies ToWorker));
        return;
    }
  }

  // What the session's tools ask of the gateway (see ToolHost in tools.ts).
  private async _rpc(method: string, args: any[]) {
    const shared = this._host.shared;
    switch (method) {
      case 'allCookies': {
        const { cookies } = await shared.cdp.send('Storage.getCookies');
        return cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires,
          httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite ?? 'Lax' }));
      }
      case 'deleteCookies': {
        // An expired copy replaces each.
        const cookies = args[0] as { name: string; domain: string; path: string }[];
        if (cookies.length)
          await shared.cdp.send('Storage.setCookies', { cookies: cookies.map(c => ({ name: c.name, value: '', domain: c.domain, path: c.path, expires: 1 })) });
        return;
      }
      case 'focusTab':
        if (!this.targets.has(args[0]))
          throw new Error('That tab is not yours.');
        return await shared.focusTab(args[0]);
      case 'answerPermissions':
        return await this._host.answerPermissions(this, args[0], args[1], args[2], args[3]);
    }
    throw new Error(`Unknown request ${method}`);
  }

  // The thread is gone (ended, crashed, or its connection dropped): what it
  // was doing is told to the agent, calls still waiting on it get an error.
  private _ended(thread: Thread, reason: string) {
    if (thread.ended)
      return;
    thread.ended = true;
    if (this._thread === thread)
      this._thread = undefined;
    for (const resolve of thread.calls.values())
      resolve({ type: 'result', id: 0, error: reason });
    thread.calls.clear();
    for (const resolve of thread.queries.values())
      resolve({ type: 'tab', id: 0 });
    thread.queries.clear();
  }

  private _endThread(thread: Thread | undefined) {
    if (!thread)
      return;
    this._ended(thread, 'The browser session\'s thread was ended.');
    void thread.worker.terminate().catch(() => {});
  }

  // What ended with a thread that the agent had running.
  private _retire() {
    const thread = this._thread;
    if (!thread)
      return;
    if (this._codeRoutes) {
      this._lostRoutes = true;
      this._notes.push('### Routes\nThe browser connection was restored: routes you added from code (browser_run_code_unsafe) are gone; routes added with browser_route, offline mode and device emulation were kept.');
    }
    this._codeRoutes = false;
    for (const what of this._running)
      this._notes.push(lostOnReconnect[what]);
    this._running.clear();
    this._endThread(thread);
  }

  // The browser connection dropped (every DevTools client goes together): the
  // tabs are still open, and the next call starts a new thread.
  detach() {
    this._retire();
  }

  // The current tab, or the one at an index of browser_tabs' list.
  async tab(index?: number): Promise<{ targetId: string; url: string; title: string } | undefined> {
    const thread = this._thread;
    if (!thread)
      return undefined;
    const id = ++this._lastId;
    const answer = new Promise<FromWorker & { type: 'tab' }>(resolve => thread.queries.set(id, resolve));
    thread.worker.postMessage({ type: 'tab', id, index } satisfies ToWorker);
    return (await answer).tab;
  }

  // Calls of one session run one at a time: the stock Context has a single
  // "current tab". A call that never settles (an evaluate awaiting a promise
  // the page never resolves) must not block the session for good, so the
  // queue moves on when the agent cancels the call or its timeout runs out;
  // the abandoned call may still finish in the page later.
  async callTool(name: string, rawArgs: any, signal?: AbortSignal) {
    const { timeout, ...args } = rawArgs ?? {};
    const seconds = callTimeoutSeconds(name, args, timeout);
    const queued = Date.now();
    const previous = this._current;
    const run = this._queue.then(async () => {
      signal?.throwIfAborted();
      const waited = Date.now() - queued;
      this._current = { name, since: Date.now() };
      const result = await this._callWithTimeout(name, args, seconds, signal);
      if (waited >= queueNoteMs && previous)
        result.content?.push({ type: 'text', text: `### Queue\nThis call waited ${Math.round(waited / 1000)} s for your ` +
          `previous call (${previous.name}) to finish: calls of one chat run one at a time.` });
      return result;
    });
    this._queue = run.catch(() => {}).finally(() => {
      this._current = undefined;
      this._scheduleIdle();
    });
    return await run;
  }

  private _queue: Promise<unknown> = Promise.resolve();
  private _current: { name: string; since: number } | undefined;

  private async _callWithTimeout(name: string, args: any, seconds: number, signal?: AbortSignal) {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const state = { abandoned: false as boolean, id: 0 };
    const call = this._callTool(name, args, state);
    call.catch(() => {});
    const giveUp = () => {
      state.abandoned = true;
      this._thread?.worker.postMessage({ type: 'abandon', id: state.id } satisfies ToWorker);
    };
    const timedOut = new Promise<any>(resolve => {
      timer = setTimeout(() => {
        giveUp();
        const url = this._currentUrl;
        console.error(`${name} from ${this.info.title} gave up after ${seconds} s`);
        resolve(errorResult(`${name} did not finish within ${seconds} s and was given up, so your next calls are not ` +
          'blocked by it. It may still be running in the page (for example an evaluate waiting on a promise that ' +
          `never resolves): check the page before repeating it.${url ? ` Your current tab is ${url}; if that page ` +
          'itself is stuck (a busy script), close it with browser_tabs action "close".' : ''} If a call really needs ` +
          'longer, pass "timeout" in seconds.'));
      }, seconds * 1000);
    });
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        giveUp();
        console.error(`${name} from ${this.info.title} was cancelled by the agent`);
        reject(signal!.reason ?? new Error('cancelled'));
      };
      if (signal?.aborted)
        onAbort();
      else
        signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([call, timedOut, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort!);
    }
  }

  // Sends a call to the thread and waits for it, ending the thread if it
  // stops answering pings (a busy loop in code the agent runs).
  private async _send(thread: Thread, name: string, args: any, tab: string | undefined, state: { id: number }) {
    const id = state.id = ++this._lastId;
    const answer = new Promise<FromWorker & { type: 'result' }>(resolve => thread.calls.set(id, resolve));
    thread.lastPong = Date.now();
    let n = 0;
    const pinger = setInterval(() => {
      if (Date.now() - thread.lastPong > stuckMs) {
        console.error(`${this.info.title}: browser thread stopped answering during ${name}; ending it`);
        thread.stuck = true;
        this._retire();
        return;
      }
      thread.worker.postMessage({ type: 'ping', n: ++n } satisfies ToWorker);
    }, pingMs);
    thread.worker.postMessage({ type: 'call', id, name, args, tab } satisfies ToWorker);
    try {
      return await answer;
    } finally {
      clearInterval(pinger);
    }
  }

  private async _callTool(name: string, rawArgs: any, state: { abandoned: boolean; id: number }) {
    this.lastActivity = Date.now();
    clearTimeout(this._idleTimer);
    if (!this._thread)
      await this._start();
    const thread = this._thread!;
    const { tab, ...args } = rawArgs ?? {};
    if (Date.now() - this._touchedAt > 5 * 60 * 1000) {
      touchFolder(this.ensureFilesDir());
      this._touchedAt = Date.now();
    }
    const message = await this._send(thread, name, args, tab === undefined ? undefined : String(tab), state);
    if (thread.stuck)
      return this._finish(errorResult(`${name} never gave the browser session a chance to answer (code that never ` +
        'yields, such as a busy loop in browser_run_code_unsafe), so the session was restarted. Your tabs are still ' +
        'open; other chats were not affected.'), state);
    if (message.error !== undefined || !message.outcome) {
      const result: any = errorResult(message.error ?? 'No answer from the browser session.');
      // The thread ended with the connection (the browser dropped them all).
      if (thread.ended)
        Object.defineProperty(result, 'cutOff', { value: true });
      return this._finish(result, state);
    }
    const outcome: CallOutcome = message.outcome;
    const result = outcome.result;
    this._remember(outcome);
    // The agent's own code closed its browser context (context.close()):
    // like browser_close, its tabs go.
    const closedByCode = outcome.disconnected && this._host.proxy.closedByClient(this.info.id);
    // The connection dropped while the call ran: the stock backend disposed
    // itself, the tabs are still open, and the gateway may repeat the call.
    const cut = outcome.disconnected && !closedByCode;
    if (cut) {
      Object.defineProperty(result, 'cutOff', { value: true });
      if (this._thread === thread)
        this._retire();
    }
    // browser_close means "close my tabs" (the stock backend only forgets
    // them); the next call gets a fresh thread.
    const closed = this._thread === thread && (closedByCode || !cut && name === 'browser_close' && outcome.disposed);
    if (!result.isError)
      this._track(name);
    if (closed)
      await this._afterClose();
    if (state.abandoned)
      return result;
    this._finish(result, state);
    if (closed || cut)
      return result;
    this._host.onTabsChanged();
    if (outcome.tabIds) {
      result.content.push({ type: 'text', text: outcome.tabIds });
      const subagents = this._host.subagentTabs(this);
      if (subagents)
        result.content.push({ type: 'text', text: subagents });
    }
    return result;
  }

  // Notes, files, permission and passkey requests go with a result.
  private _finish(result: any, state: { abandoned: boolean }) {
    if (state.abandoned)
      return result;
    // Saved files are named by absolute path: given "./shot.png", agents went
    // looking for it with `find /`, which scans other apps' data and makes
    // macOS ask the user for access.
    const filesDir = this.ensureFilesDir();
    for (const part of result.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string')
        part.text = absolutePaths(part.text, filesDir);
    }
    if (!this._filesNoted && !result.isError) {
      this._filesNoted = true;
      result.content.push({ type: 'text', text: `### Files\nFiles this browser session saves (screenshots, snapshots, downloads, videos, ` +
        `traces) go to ${filesDir}. It is deleted after ${this._retentionDays} days without use: copy anything worth ` +
        'keeping into the project.' });
    }
    for (const note of this._notes.splice(0))
      result.content.push({ type: 'text', text: note });
    const permissions = this._host.permissionNotes(this);
    if (permissions)
      result.content.push({ type: 'text', text: permissions });
    const passkeys = describePasskeyRequests(this.passkeyRequests.splice(0));
    if (passkeys)
      result.content.push({ type: 'text', text: passkeys });
    return result;
  }

  // What the thread reported that a new one must know.
  private _remember(outcome: CallOutcome) {
    if (!outcome.disconnected) {
      this.currentTarget = outcome.currentTarget;
      this._currentUrl = outcome.currentUrl;
    }
    this._routes = outcome.routes;
    this._codeRoutes = outcome.codeRoutes;
    this.offline = outcome.offline;
    this.emulation = new Map(outcome.emulation);
  }

  // What the agent started (and has not stopped) that a new thread would end.
  private _track(name: string) {
    const match = name.match(/^browser_(start|stop)_(video|recording|tracing)$/);
    if (match)
      match[1] === 'start' ? this._running.add(match[2] as any) : this._running.delete(match[2] as any);
  }

  // Ends the thread when the session has had nothing to do for a while and
  // nothing running that would end with it.
  private _scheduleIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this._thread && !this._current && !this._running.size && !this._codeRoutes && Date.now() - this.lastActivity >= idleMs)
        this._endThread(this._thread);
    }, idleMs);
    this._idleTimer.unref();
  }

  // browser_close: "close my browser" means the tabs, routes and offline mode
  // go too, as with upstream's own browser.
  private async _afterClose() {
    this._endThread(this._thread);
    this._routes = [];
    this._lostRoutes = false;
    this._codeRoutes = false;
    this.offline = false;
    this.emulation.clear();
    this._running.clear();
    this.currentTarget = undefined;
    for (const targetId of this.targets)
      await this._host.shared.closeTarget(targetId);
  }

  // Told to the agent in its next result.
  note(text: string) {
    this._notes.push(text);
  }

  // A link one of this session's pages opens in a new tab (see popups.ts):
  // a background tab of this session, with that page as its opener. It opens
  // blank and goes to the link once the session's Playwright has set it up
  // (see SharedBrowser.createTarget).
  async openInBackground(url: string, openerTargetId: string) {
    if (!/^https?:/i.test(url) || internalUrl(url, this.internalPorts))
      return;
    await this._host.shared.createTarget({ owner: this.info.id, opener: openerTargetId, navigateTo: url });
  }

  // Set once the session has ended.
  private _disposed = false;

  get disposed() {
    return this._disposed;
  }

  async dispose({ closeTabs }: { closeTabs: boolean }) {
    this._disposed = true;
    clearTimeout(this._idleTimer);
    this._endThread(this._thread);
    this._notes = [];
    if (closeTabs) {
      for (const targetId of this.targets)
        await this._host.shared?.closeTarget(targetId);
    }
    this._host.proxy?.forget(this.info.id);
  }

  // What survives a gateway restart: offline mode, routes made with
  // browser_route (routes from code cannot be saved) and device emulation.
  savedState(): SavedNetworkState {
    const targets = this.targets;
    return {
      offline: this.offline,
      routes: this._routes,
      emulation: [...this.emulation].filter(([id]) => targets.has(id)),
      lostRoutes: this._lostRoutes || this._codeRoutes,
      tracing: this._running.has('tracing'),
      recording: this._running.has('recording'),
    };
  }

  restoreSavedState(saved: SavedNetworkState | undefined) {
    if (!saved)
      return;
    this.offline = saved.offline;
    this._routes = saved.routes;
    this.emulation = new Map(saved.emulation);
    if (saved.tracing)
      this._notes.push('### Tracing\nTracing stopped: the browser gateway restarted. Start it again if you still need it.');
    if (saved.recording)
      this._notes.push('### Recording\nThe action recording stopped: the browser gateway restarted. Start it again if you still need it.');
    if (saved.lostRoutes)
      this._notes.push('### Routes\nThe browser gateway restarted: routes you added from code (browser_run_code_unsafe) are gone; routes added with browser_route, offline mode and device emulation were kept.');
    // The agent was told where its files are before.
    this.started = true;
    this._filesNoted = true;
  }
}

// Relative file paths in a result ("./shot.png", "shots/a.png", "../x.pdf")
// become absolute. Only paths of files that exist are changed, so text from the
// page (a link to "./about") stays as it is.
function absolutePaths(text: string, filesDir: string) {
  return text.replace(/(^|[\s("'`])((?:\.\.?\/)*[\w@%+~-][\w@%+~.\/-]*\.[A-Za-z0-9]{1,8})(?=$|[\s)"'`,;])/g, (match, before: string, name: string) => {
    const file = path.resolve(filesDir, name);
    try {
      return fs.statSync(file).isFile() ? `${before}${file}` : match;
    } catch {
      return match;
    }
  });
}
