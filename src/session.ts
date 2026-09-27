// One agent session = one chat (or subagent) = one stock Playwright MCP
// BrowserBackend on a Playwright connection of its own, made through the
// proxy (see proxy.ts), which shows it only the session's tabs. Isolation
// comes from that connection, not from changes to Playwright MCP; what this
// file adds is the gateway's own behavior around the calls: one call at a
// time with a timeout, notes for the agent, files in the session's folder, and
// keeping routes, offline mode and device emulation across reconnects.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page, Route } from 'playwright-core';
import type { SharedBrowser } from './browser.js';
import type { TabGroups } from './groups.js';
import type { CdpProxy } from './proxy.js';
import { touchFolder } from './files.js';
import { agentCall } from './netguard.js';
import { playwright, pwTools, verifyContext } from './internals.js';
import { applyEmulation, type Emulation } from './tools.js';
import { internalUrl } from './urls.js';
import { loadProfiles } from './profiles.js';
import { describePasskeyRequests, type PasskeyRequest } from './passkeys.js';
import type { PermissionRequest } from './permissions.js';

// The state of the tool call running (given up or not), see _callWithTimeout.
const callState = new AsyncLocalStorage<{ abandoned: boolean }>();

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

// The handler browser_route builds from its parameters (as upstream), for
// routes brought back after a reconnect or restart.
function routeHandler(params: any) {
  return async (route: Route) => {
    if (params.body !== undefined || params.status !== undefined) {
      await route.fulfill({ status: params.status ?? 200, contentType: params.contentType, body: params.body });
      return;
    }
    const headers = { ...route.request().headers() };
    for (const [key, value] of Object.entries(params.addHeaders ?? {}))
      headers[key] = value as string;
    for (const header of params.removeHeaders ?? [])
      delete headers[header.toLowerCase()];
    await route.continue({ headers });
  };
}

// Things a dropped connection or a restart ends, with what the agent is told.
const lostOnReconnect: Record<string, string> = {
  video: '### Video\nThe video recording stopped: the browser connection dropped and was restored. Start it again if you still need it.',
  recording: '### Recording\nThe action recording stopped: the browser connection dropped and was restored. Start it again if you still need it.',
  tracing: '### Tracing\nTracing stopped: the browser connection dropped and was restored. Start it again if you still need it.',
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
  // Target id of the current tab, remembered across reconnects and restarts.
  currentTarget: string | undefined;
  backend: any;
  private _browser: Browser | undefined;
  private _host: SessionHost;
  private _config: any;
  private _tools: any[];
  private _filesNoted = false;
  // Told to the agent in the next tool result.
  private _notes: string[] = [];
  private _touchedAt = 0;
  private _retentionDays: number;
  private _targetIds = new WeakMap<Page, string>();
  // Kept here, not only in the backend, to be set up again on a new one.
  private _routes: any[] = [];
  private _lostRoutes = false;
  offline = false;
  // Device emulation by tab (target id), see browser_emulate_device.
  emulation = new Map<string, Emulation>();
  // What the agent's code may not connect to (see netguard.ts).
  private _guard = { internalPorts: () => this._host.internalPorts() };
  // Started by the agent and not stopped yet: ended by a reconnect.
  private _running = new Set<'video' | 'recording' | 'tracing'>();

  constructor(info: SessionInfo, host: SessionHost, config: any, tools: any[], retentionDays = 7) {
    this.info = info;
    this._host = host;
    this._retentionDays = retentionDays;
    this._config = config;
    this._tools = tools;
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
    // The session folder is both the output dir and the workspace, so relative
    // file names land there too, never in the agent's project. Unrestricted
    // access lets the agent still upload project files by absolute path.
    const config = { ...this._config, outputDir: filesDir, allowUnrestrictedFileAccess: true };
    // As upstream connects to a CDP endpoint: traces (and download temp files)
    // go to the output folder's "traces".
    // Made inside the agent's network guard (see netguard.ts), so everything
    // this connection's Playwright does later (route handlers, event
    // listeners, requests) stays inside it too.
    const browser: Browser = await agentCall.run(this._guard, () => playwright.chromium.connectOverCDP(this._host.proxy.endpoint(this.info.id),
        { timeout: 15_000, artifactsDir: path.join(filesDir, 'traces') }));
    const backend = new pwTools.BrowserBackend(config, browser.contexts()[0], this._tools, async () => {});
    await backend.initialize({ cwd: filesDir, clientName: this.info.title });
    const context = backend._context;
    verifyContext(context);
    context._agentSession = this;
    this._patchContext(context);
    this._browser = browser;
    this.backend = backend;
    await context.ensureBrowserContext();
    // Set up again what the agent had before a reconnect or restart.
    for (const params of this._routes)
      await context.addRoute({ ...params, handler: routeHandler(params) }).catch(() => {});
    if (this.offline)
      await browser.contexts()[0].setOffline(true).catch(() => {});
    for (const tab of context.tabs()) {
      const targetId = await this.targetIdOf(tab.page).catch(() => undefined);
      const settings = targetId && this.emulation.get(targetId);
      if (settings)
        await applyEmulation(tab.page, settings).catch(() => {});
      if (targetId && targetId === this.currentTarget)
        context._currentTab = tab;
    }
  }

  // The target id of one of the session's pages.
  async targetIdOf(page: Page): Promise<string> {
    let id = this._targetIds.get(page);
    if (id)
      return id;
    const cdp = await page.context().newCDPSession(page);
    try {
      id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId as string;
    } finally {
      await cdp.detach().catch(() => {});
    }
    this._targetIds.set(page, id);
    return id;
  }

  // The browser connection dropped (every DevTools client goes together): the
  // backend is dead, the tabs are still open, and the next call reconnects.
  detach() {
    this._retire();
  }

  // What the old backend had that a new one must know, and what ended with it.
  private _retire() {
    const backend = this.backend;
    if (!backend)
      return;
    this.backend = undefined;
    const browser = this._browser;
    this._browser = undefined;
    const context = backend._context;
    this._routes = (context?.routes() ?? []).map(({ handler, ...params }: any) => params);
    // Routes added from code (browser_run_code_unsafe) are not in the list.
    const codeRoutes = ((browser?.contexts()[0] as any)?._routes?.length ?? 0) > this._routes.length;
    this._lostRoutes ||= codeRoutes;
    if (codeRoutes)
      this._notes.push('### Routes\nThe browser connection was restored: routes you added from code (browser_run_code_unsafe) are gone; routes added with browser_route, offline mode and device emulation were kept.');
    for (const what of this._running)
      this._notes.push(lostOnReconnect[what]);
    this._running.clear();
    void backend.dispose().catch(() => {});
    void browser?.close().catch(() => {});
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
    this._queue = run.catch(() => {}).finally(() => this._current = undefined);
    return await run;
  }

  private _queue: Promise<unknown> = Promise.resolve();
  private _current: { name: string; since: number } | undefined;

  private async _callWithTimeout(name: string, args: any, seconds: number, signal?: AbortSignal) {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // An abandoned call that finishes later must not take the notes meant for
    // the agent's next result.
    const state = { abandoned: false as boolean };
    const call = agentCall.run(this._guard, () => callState.run(state, () => this._callTool(name, args, signal, state)));
    call.catch(() => {});
    const timedOut = new Promise<any>(resolve => {
      timer = setTimeout(() => {
        state.abandoned = true;
        const url = this.currentPage()?.url();
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
        state.abandoned = true;
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

  private async _callTool(name: string, rawArgs: any, signal?: AbortSignal, state: { abandoned: boolean } = { abandoned: false }) {
    this.lastActivity = Date.now();
    if (this.backend && (this.backend._disconnected || !this._browser?.isConnected()))
      this._retire();
    if (!this.backend)
      await this._start();
    const backend = this.backend;
    const { tab, ...args } = rawArgs ?? {};
    if (tab !== undefined) {
      const context = backend._context;
      await context.ensureBrowserContext();
      const target = await this._findTab(context, String(tab));
      if (!target)
        return errorResult(`Tab "${tab}" not found. Call browser_tabs to list your tabs.`);
      context._currentTab = target;
    }
    if (Date.now() - this._touchedAt > 5 * 60 * 1000) {
      touchFolder(this.ensureFilesDir());
      this._touchedAt = Date.now();
    }
    const browser = this._browser;
    const result = await backend.callTool(name, args, signal);
    const disconnected = !browser?.isConnected() || !!backend._disconnected;
    // The agent's own code closed its browser context (context.close()):
    // like browser_close, its tabs go.
    const closedByCode = disconnected && this._host.proxy.closedByClient(this.info.id);
    // The connection dropped while the call ran: the stock backend disposed
    // itself, the tabs are still open, and the gateway may repeat the call.
    const cut = disconnected && !closedByCode;
    if (cut) {
      Object.defineProperty(result, 'cutOff', { value: true });
      if (this.backend === backend)
        this._retire();
    }
    // browser_close means "close my tabs" (the stock backend only forgets
    // them); the next call gets a fresh backend.
    const closed = this.backend === backend && (closedByCode || !cut && name === 'browser_close' && backend._disposed);
    if (!result.isError)
      this._track(name);
    if (state.abandoned) {
      if (closed)
        await this._afterClose();
      return result;
    }
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
    if (closed) {
      await this._afterClose();
      return result;
    }
    if (cut)
      return result;
    const current = this.currentPage();
    this.currentTarget = current ? await this.targetIdOf(current).catch(() => this.currentTarget) : undefined;
    this._host.onTabsChanged();
    if (name === 'browser_tabs' && !result.isError) {
      result.content.push({ type: 'text', text: await this._tabIds() });
      const subagents = this._host.subagentTabs(this);
      if (subagents)
        result.content.push({ type: 'text', text: subagents });
    }
    return result;
  }

  // What the agent started (and has not stopped) that a reconnect would end.
  private _track(name: string) {
    const match = name.match(/^browser_(start|stop)_(video|recording|tracing)$/);
    if (match)
      match[1] === 'start' ? this._running.add(match[2] as any) : this._running.delete(match[2] as any);
    if (name === 'browser_route' || name === 'browser_unroute')
      this._routes = (this.backend?._context?.routes() ?? []).map(({ handler, ...params }: any) => params);
  }

  // browser_close disposed the backend: "close my browser" means the tabs,
  // routes and offline mode go too, as with upstream's own browser.
  private async _afterClose() {
    const browser = this._browser;
    this.backend = undefined;
    this._browser = undefined;
    this._routes = [];
    this._lostRoutes = false;
    this.offline = false;
    this.emulation.clear();
    this._running.clear();
    for (const targetId of this.targets)
      await this._host.shared.closeTarget(targetId);
    await browser?.close().catch(() => {});
  }

  private async _findTab(context: any, id: string) {
    for (const tab of context._tabs) {
      if ((await this.targetIdOf(tab.page)).startsWith(id.toUpperCase()))
        return tab;
    }
    return undefined;
  }

  // Stable ids for the `tab` parameter; indexes shift when tabs close.
  private async _tabIds() {
    const context = this.backend._context;
    const lines = [];
    for (const [index, tab] of context._tabs.entries()) {
      const id = (await this.targetIdOf(tab.page)).slice(0, 8);
      lines.push(`- ${index}: ${id}${tab === context._currentTab ? ' (current)' : ''}`);
    }
    return `### Tab ids\n${lines.join('\n')}\nPass "tab": "<id>" to any tool to act on that tab.`;
  }

  currentPage(): Page | undefined {
    return this.backend?._context?.currentTab()?.page;
  }

  // Cookies of any site, for the cookie tools when the agent names a domain
  // (the session's own connection sees only its sites' cookies, see proxy.ts).
  async allCookies(): Promise<any[]> {
    const { cookies } = await this._host.shared.cdp.send('Storage.getCookies');
    return cookies.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite ?? 'Lax' }));
  }

  // Deletes cookies of any site (an expired copy replaces each).
  async deleteCookies(cookies: { name: string; domain: string; path: string }[]) {
    if (cookies.length)
      await this._host.shared.cdp.send('Storage.setCookies', { cookies: cookies.map(c => ({ name: c.name, value: '', domain: c.domain, path: c.path, expires: 1 })) });
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
    this._retire();
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
    const routes = this.backend ? (this.backend._context?.routes() ?? []).map(({ handler, ...params }: any) => params) : this._routes;
    const targets = this.targets;
    return {
      offline: this.offline,
      routes,
      emulation: [...this.emulation].filter(([id]) => targets.has(id)),
      lostRoutes: this._lostRoutes || ((this._browser?.contexts()[0] as any)?._routes?.length ?? 0) > routes.length,
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

  private _patchContext(context: any) {
    // A call given up at its timeout keeps running; whatever it does, it no
    // longer changes which tab is current (the agent has moved on, maybe to
    // another tab). Tabs closing still move it, from outside any call.
    let currentTab = context._currentTab;
    Object.defineProperty(context, '_currentTab', {
      configurable: true,
      get: () => currentTab,
      set: (tab: any) => {
        if (!callState.getStore()?.abandoned)
          currentTab = tab;
      },
    });

    // Each stock Context listens for unhandled rejections process-wide and
    // hands every one to its agent: with many contexts in one process, one
    // chat's failed download showed up in every other chat's next result.
    // The gateway logs them instead (see gateway.ts).
    process.off('unhandledRejection', context._onUnhandledRejection);

    // Tab headers that cannot hang (see patchTabHeader).
    const onPageCreated = context._onPageCreated.bind(context);
    context._onPageCreated = function(page: Page) {
      onPageCreated(page);
      const tab = this._tabs.find((tab: any) => tab.page === page);
      if (tab)
        patchTabHeader(tab);
    };
    for (const tab of context._tabs)
      patchTabHeader(tab);
  }
}

// Every result lists the session's tabs with their titles; a page whose
// renderer is busy (an endless loop) never answers page.title(), which made
// every later call of the session hang too. Give up on the title after a while.
const headerTimeoutMs = 2000;

function patchTabHeader(tab: any) {
  if (tab.__headerPatched)
    return;
  tab.__headerPatched = true;
  const original = tab.headerSnapshot.bind(tab);
  tab.headerSnapshot = async () => {
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), headerTimeoutMs));
    const header = await Promise.race([original(), slow]);
    clearTimeout(timer);
    return header ?? {
      title: '(not responding: the page is busy; close this tab if it stays stuck)',
      url: tab.page.url(),
      current: tab.isCurrentTab(),
      crashed: false,
      mainDocumentStatus: tab._mainDocumentStatus,
      console: { total: 0, errors: 0, warnings: 0 },
      changed: true,
    };
  };
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
