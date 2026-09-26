// One agent session = one MCP connection = one Playwright MCP BrowserBackend
// sharing the profile's browser context. The stock Context adopts every page in
// the browser context and opens tabs in the foreground; here each session only
// sees the tabs it opened (plus popups those tabs open), and opens them in the
// background.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, CDPSession, Page, Request, Route } from 'playwright-core';
import type { SharedBrowser } from './browser.js';
import type { TabGroups } from './groups.js';
import { touchFolder } from './files.js';
import { pwTools, verifyContext } from './internals.js';
import { removeSnippetListeners } from './isolation.js';
import { callingSession, forgetTracing, isRecording, isTracing, startRecording, stopRecording, stopTracing } from './recording.js';
import { releaseContextWide } from './scoped.js';
import { applyEmulation, type Emulation } from './tools.js';
import { internalUrlResolved } from './urls.js';
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

// What a session needs from the gateway. Both are replaced when the gateway
// reconnects to the browser, so sessions always look them up.
export type SessionHost = {
  readonly shared: SharedBrowser;
  readonly groups: TabGroups | undefined;
  // Creates (or finds again) the session's files folder.
  filesFolder(session: AgentSession): string;
  onSessionStarted(session: AgentSession): void;
  onTabsChanged(): void;
  // Permission requests of the session's pages the agent should hear about.
  permissionNotes(session: AgentSession): string | undefined;
  // A forked chat's first start: copies of the original chat's tabs, adopted
  // by the session; resolves to a note for the agent, if there were any.
  copyForkedTabs(session: AgentSession): Promise<string | undefined>;
  // The gateway's own address (its status page is not for agents).
  readonly baseUrl: string;
  // The browser's DevTools endpoint.
  readonly cdpEndpoint: string;
  // The tabs of the session's subagents, listed in its browser_tabs results.
  subagentTabs(session: AgentSession): string | undefined;
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

function profilePorts() {
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
// routes restored after a gateway restart.
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

export class AgentSession {
  readonly info: SessionInfo;
  readonly owned = new Set<Page>();
  // Target ids of the owned tabs. Unlike `owned` they survive a dropped browser
  // connection, so the tabs can be found again after reconnecting.
  readonly targets = new Set<string>();
  // Target id of the current tab when the session was last detached or restored.
  currentTarget: string | undefined;
  backend: any;
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
  private _host: SessionHost;
  private _config: any;
  private _tools: any[];
  private _filesNoted = false;
  // Told to the agent in the next tool result.
  private _notes: string[] = [];
  private _touchedAt = 0;
  private _retentionDays: number;
  // Tabs found again after a reconnect or restart, adopted by the next backend.
  private _restored: { pages: Page[]; current?: Page } | undefined;

  constructor(info: SessionInfo, host: SessionHost, config: any, tools: any[], retentionDays = 7) {
    this.info = info;
    this._host = host;
    this._retentionDays = retentionDays;
    this._config = config;
    this._tools = tools;
  }

  ensureFilesDir(): string {
    if (!this.filesDir) {
      this.filesDir = this._host.filesFolder(this);
      fs.mkdirSync(this.filesDir, { recursive: true });
    }
    return this.filesDir;
  }

  private get _shared() {
    return this._host.shared;
  }

  private get _groups() {
    return this._host.groups;
  }

  async start() {
    const first = !this.started;
    if (first) {
      this.started = true;
      this._host.onSessionStarted(this);
    }
    const filesDir = this.ensureFilesDir();
    // The session folder is both the output dir and the workspace, so relative
    // file names land there too, never in the agent's project. Unrestricted
    // access lets the agent still upload project files by absolute path.
    const config = { ...this._config, outputDir: filesDir, allowUnrestrictedFileAccess: true };
    // browser_close ends in backend.dispose(), which calls this; the session's
    // tabs are closed after the call (see _callTool), not here.
    // The stock backend listens for its browser context closing and the
    // browser disconnecting, and never stops: with one backend per session
    // (and a new one after each browser_close) on a connection that lives for
    // days, those listeners, and the backends they hold, piled up.
    const context: any = this._shared.context;
    const browser: any = context.browser();
    const before = { close: context.listeners('close'), disconnected: browser?.listeners('disconnected') ?? [] };
    const backend = new pwTools.BrowserBackend(config, this._shared.context, this._tools, async () => {});
    const added = {
      close: context.listeners('close').filter((l: Function) => !before.close.includes(l)),
      disconnected: (browser?.listeners('disconnected') ?? []).filter((l: Function) => !before.disconnected.includes(l)),
    };
    const dispose = backend.dispose.bind(backend);
    backend.dispose = async () => {
      for (const listener of added.close)
        context.off('close', listener as any);
      for (const listener of added.disconnected)
        browser?.off('disconnected', listener as any);
      await dispose();
    };
    await backend.initialize({ cwd: filesDir, clientName: this.info.title });
    verifyContext(backend._context);
    this._patchContext(backend._context);
    this.backend = backend;
    const restored = this._restored;
    this._restored = undefined;
    if (restored?.pages.length) {
      const context = backend._context;
      await context.ensureBrowserContext();
      for (const page of restored.pages)
        this._adopt(context, page);
      context._currentTab = context._tabs.find((tab: any) => tab.page === restored.current) ?? context._tabs[0];
    }
    if (first && !this.targets.size) {
      const note = await this._host.copyForkedTabs(this).catch(e => `### Tabs of the original chat\nCould not copy them: ${(e as Error).message}`);
      if (note)
        this._notes.push(note);
    }
  }

  get gatewayUrl() {
    return this._host.baseUrl;
  }

  // Ports of addresses agents may not open (see urls.ts): this gateway's and
  // its browser's, and those of every other profile (they may run too).
  get internalPorts() {
    return [new URL(this._host.baseUrl).port, new URL(this._host.cdpEndpoint).port, ...profilePorts()];
  }

  // Tabs copied for a forked chat: adopted in order, the last one flagged
  // current becomes the current tab.
  async adoptCopies(pages: { page: Page; current: boolean }[]) {
    const context = this.backend._context;
    await context.ensureBrowserContext();
    for (const { page } of pages) {
      this._adopt(context, page);
      await this._groups?.addPage(this, page).catch(() => {});
    }
    const current = pages.find(p => p.current)?.page ?? pages[0]?.page;
    context._currentTab = context._tabs.find((tab: any) => tab.page === current) ?? context._currentTab;
  }

  // The browser connection dropped: the backend and its pages are dead, but
  // the tabs are still open in the browser (see `targets`).
  detach() {
    const backend = this.backend;
    // Listeners snippets left on the old connection's objects never fire
    // again; they only hold that connection in memory.
    removeSnippetListeners(this);
    // What lived in the old connection is gone; the agent is told.
    if (backend?._context?._video)
      this._notes.push('### Video\nThe video recording stopped: the browser connection dropped and was restored. Start it again if you still need it.');
    if (isRecording(this, this._shared.context)) {
      void stopRecording(this, this._shared.context).catch(() => {});
      this._notes.push('### Recording\nThe action recording stopped: the browser connection dropped and was restored. Start it again if you still need it.');
    }
    if (isTracing(this)) {
      forgetTracing(this);
      void stopTracing(this, this._shared.context, true).catch(() => {});
      this._notes.push('### Tracing\nTracing stopped: the browser connection dropped and was restored. Start it again if you still need it.');
    }
    this.backend = undefined;
    this.owned.clear();
    this._restored = undefined;
    void backend?.dispose().catch(() => {});
  }

  // Hands the session its tabs again after a reconnect or a gateway restart.
  restore(pages: Map<string, Page>) {
    const found: Page[] = [];
    for (const targetId of [...this.targets]) {
      const page = pages.get(targetId);
      if (!page) {
        this.targets.delete(targetId);
        continue;
      }
      found.push(page);
      this.owned.add(page);
      page.once('close', () => this.owned.delete(page));
    }
    if (found.length) {
      // The agent was told where its files are before.
      this.started = true;
      this._filesNoted = true;
    }
    this._restored = { pages: found, current: this.currentTarget ? pages.get(this.currentTarget) : undefined };
  }

  // For the saved state: the current tab's target id.
  currentTargetId(): string | undefined {
    const page = this.backend?._context?.currentTab()?.page;
    return (page && this._shared.cachedTargetId(page)) ?? this.currentTarget;
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
    const previous = this._running;
    const run = this._queue.then(async () => {
      signal?.throwIfAborted();
      const waited = Date.now() - queued;
      this._running = { name, since: Date.now() };
      const result = await this._callWithTimeout(name, args, seconds, signal);
      if (waited >= queueNoteMs && previous)
        result.content?.push({ type: 'text', text: `### Queue\nThis call waited ${Math.round(waited / 1000)} s for your ` +
          `previous call (${previous.name}) to finish: calls of one chat run one at a time.` });
      return result;
    });
    this._queue = run.catch(() => {}).finally(() => this._running = undefined);
    return await run;
  }

  private async _callWithTimeout(name: string, args: any, seconds: number, signal?: AbortSignal) {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    // An abandoned call that finishes later must not take the notes meant for
    // the agent's next result.
    const state = { abandoned: false as boolean };
    const call = callingSession.run(this, () => callState.run(state, () => this._callTool(name, args, signal, state)));
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

  // Routes and offline mode of this session. They live here, not on the stock
  // Context (replaced after a reconnect), and are registered on the shared
  // browser context with an owner check: context-level routes reach a new
  // tab before its first load (popups included), while requests of other
  // chats' pages fall through to their own routes.
  routes: any[] = [];
  offline = false;
  // Device emulation by tab (target id), see browser_emulate_device.
  emulation = new Map<string, Emulation>();
  private _registered = new Map<any, { context: BrowserContext; handler: (route: Route, request: Request) => Promise<void> }>();
  private _offlineRoute: { context: BrowserContext; handler: (route: Route, request: Request) => Promise<void> } | undefined;
  private _networkSessions = new Map<Page, Promise<CDPSession>>();

  // A page of this session: one of its tabs, or a popup opened by one.
  async ownsPage(page: Page | null | undefined, depth = 0): Promise<boolean> {
    if (!page)
      return false;
    if (this.owned.has(page))
      return true;
    if (depth >= 3)
      return false;
    return await this.ownsPage(await page.opener().catch(() => null), depth + 1);
  }

  async ownsRequest(request: Request): Promise<boolean> {
    // Service worker requests have no frame.
    if (request.serviceWorker())
      return false;
    try {
      return await this.ownsPage(request.frame().page());
    } catch {
      // A popup's first request comes before Playwright knows its page: its
      // opener (as Chrome reports it) tells whose it is.
      if (!request.isNavigationRequest())
        return false;
      const opener = await this._shared.popupOpener();
      return !!opener && this.targets.has(opener);
    }
  }

  async addRoute(entry: any) {
    this.routes.push(entry);
    await this._registerRoute(entry);
    this._host.onTabsChanged();
  }

  async removeRoutes(pattern?: string) {
    const removed = this.routes.filter(route => !pattern || route.pattern === pattern);
    for (const route of removed)
      await this._unregisterRoute(route);
    this.routes = this.routes.filter(route => !removed.includes(route));
    this._host.onTabsChanged();
    return removed.length;
  }

  private async _registerRoute(entry: any) {
    const context = this._shared.context;
    const handler = async (route: Route, request: Request) => {
      if (await this.ownsRequest(request))
        return await entry.handler(route, request);
      await route.fallback();
    };
    await context.route(entry.pattern, handler);
    this._registered.set(entry, { context, handler });
  }

  private async _unregisterRoute(entry: any) {
    const registered = this._registered.get(entry);
    this._registered.delete(entry);
    await registered?.context.unroute(entry.pattern, registered.handler).catch(() => {});
  }

  async setOffline(offline: boolean) {
    this.offline = offline;
    this._host.onTabsChanged();
    await this._syncOfflineRoute();
    for (const page of this.owned)
      await this._emulateOffline(page, offline).catch(() => {});
  }

  // Requests fail at once (even a new tab's first load); the per-page network
  // emulation also makes navigator.onLine report it.
  private async _syncOfflineRoute() {
    if (this.offline && !this._offlineRoute) {
      const context = this._shared.context;
      const handler = async (route: Route, request: Request) => {
        if (await this.ownsRequest(request))
          return await route.abort('internetdisconnected');
        await route.fallback();
      };
      await context.route('**', handler);
      this._offlineRoute = { context, handler };
    } else if (!this.offline && this._offlineRoute) {
      const { context, handler } = this._offlineRoute;
      this._offlineRoute = undefined;
      await context.unroute('**', handler).catch(() => {});
    }
  }

  async _emulateOffline(page: Page, offline: boolean) {
    let cdp = this._networkSessions.get(page);
    if (!cdp) {
      if (!offline)
        return;
      cdp = page.context().newCDPSession(page).then(async session => {
        await session.send('Network.enable');
        return session;
      });
      this._networkSessions.set(page, cdp);
      page.once('close', () => this._networkSessions.delete(page));
    }
    await (await cdp).send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  // After a reconnect the shared browser context is a new one: register the
  // session's routes and network state on it again.
  async reapplyNetworkState() {
    this._registered.clear();
    this._offlineRoute = undefined;
    this._networkSessions.clear();
    for (const entry of this.routes)
      await this._registerRoute(entry).catch(() => {});
    await this._syncOfflineRoute().catch(() => {});
    for (const page of this.owned) {
      if (this.offline)
        await this._emulateOffline(page, true).catch(() => {});
      const targetId = this._shared.cachedTargetId(page);
      const settings = targetId && this.emulation.get(targetId);
      if (settings)
        await applyEmulation(page, settings).catch(() => {});
    }
    for (const targetId of [...this.emulation.keys()]) {
      if (!this.targets.has(targetId))
        this.emulation.delete(targetId);
    }
  }

  // What survives a gateway restart: offline mode, routes made with
  // browser_route (routes from code cannot be saved) and device emulation.
  savedState(): SavedNetworkState {
    return {
      offline: this.offline,
      routes: this.routes.filter(route => !route.fromCode).map(({ handler, ...params }) => params),
      emulation: [...this.emulation].filter(([id]) => this.targets.has(id)),
      lostRoutes: this.routes.some(route => route.fromCode),
      tracing: isTracing(this),
      recording: isRecording(this, this._shared.context),
    };
  }

  restoreSavedState(saved: SavedNetworkState | undefined) {
    if (!saved)
      return;
    this.offline = saved.offline;
    this.routes = saved.routes.map(params => ({ ...params, handler: routeHandler(params) }));
    this.emulation = new Map(saved.emulation);
    if (saved.tracing)
      this._notes.push('### Tracing\nTracing stopped: the browser gateway restarted. Start it again if you still need it.');
    if (saved.recording)
      this._notes.push('### Recording\nThe action recording stopped: the browser gateway restarted. Start it again if you still need it.');
    if (saved.lostRoutes)
      this._notes.push('### Routes\nThe browser gateway restarted: routes you added from code (browser_run_code_unsafe) are gone; routes added with browser_route, offline mode and device emulation were kept.');
  }

  private async _clearNetworkState() {
    for (const entry of [...this._registered.keys()])
      await this._unregisterRoute(entry);
    this.routes = [];
    this.offline = false;
    await this._syncOfflineRoute().catch(() => {});
  }

  // Tabs opened by this session's pages, for page.waitForEvent('popup') in
  // browser_run_code_unsafe (such tabs have no opener, see popups.ts).
  private _popupListeners = new Set<(opener: Page, popup: Page) => void>();
  openers = new WeakMap<Page, Page>();

  onPopup(listener: (opener: Page, popup: Page) => void) {
    this._popupListeners.add(listener);
    return () => this._popupListeners.delete(listener);
  }

  private _popupOpened(opener: Page, popup: Page) {
    this.openers.set(popup, opener);
    for (const listener of this._popupListeners)
      listener(opener, popup);
  }

  // Tabs this session adopted, for context "page" events in the isolated view.
  private _adoptListeners = new Set<(page: Page) => void>();

  onAdopt(listener: (page: Page) => void) {
    this._adoptListeners.add(listener);
    return () => this._adoptListeners.delete(listener);
  }

  private _queue: Promise<unknown> = Promise.resolve();
  private _running: { name: string; since: number } | undefined;

  private async _callTool(name: string, rawArgs: any, signal?: AbortSignal, state: { abandoned: boolean } = { abandoned: false }) {
    this.lastActivity = Date.now();
    if (!this.backend)
      await this.start();
    const { tab, ...args } = rawArgs ?? {};
    if (tab !== undefined) {
      const context = this.backend._context;
      await context.ensureBrowserContext();
      const target = await this._findTab(context, String(tab));
      if (!target)
        return { content: [{ type: 'text', text: `### Error\nTab "${tab}" not found. Call browser_tabs to list your tabs.` }], isError: true };
      context._currentTab = target;
    }
    if (Date.now() - this._touchedAt > 5 * 60 * 1000) {
      touchFolder(this.ensureFilesDir());
      this._touchedAt = Date.now();
    }
    const result = await this.backend.callTool(name, args, signal);
    if (state.abandoned) {
      if (this.backend?._disposed)
        await this._afterClose();
      return result;
    }
    // Tell the agent once where its files go; paths in later results are
    // relative to this folder.
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
    // Remembered for a dropped connection, when the pages are already gone.
    this.currentTarget = this.currentTargetId();
    // browser_close disposes the backend and means "close my tabs": the
    // stock Context only forgets them. The next call gets a fresh backend.
    if (this.backend._disposed) {
      await this._afterClose();
    } else if (name === 'browser_tabs' && !result.isError) {
      result.content.push({ type: 'text', text: await this._tabIds() });
      const subagents = this._host.subagentTabs(this);
      if (subagents)
        result.content.push({ type: 'text', text: subagents });
    }
    return result;
  }

  // browser_close disposed the backend: "close my browser" means the tabs,
  // routes and offline mode go too, as with upstream's own browser.
  private async _afterClose() {
    this.backend = undefined;
    for (const page of [...this.owned])
      await page.close().catch(() => {});
    await this._clearNetworkState();
    await releaseContextWide(this, this._shared.context).catch(() => {});
  }

  private async _findTab(context: any, id: string) {
    for (const tab of context._tabs) {
      if ((await this._shared.targetId(tab.page)).startsWith(id.toUpperCase()))
        return tab;
    }
    return undefined;
  }

  // Stable ids for the `tab` parameter; indexes shift when tabs close.
  private async _tabIds() {
    const context = this.backend._context;
    const lines = [];
    for (const [index, tab] of context._tabs.entries()) {
      const id = (await this._shared.targetId(tab.page)).slice(0, 8);
      lines.push(`- ${index}: ${id}${tab === context._currentTab ? ' (current)' : ''}`);
    }
    return `### Tab ids\n${lines.join('\n')}\nPass "tab": "<id>" to any tool to act on that tab.`;
  }

  // A link this session's page wanted to open in a new tab (see popups.ts):
  // becomes one of our tabs, in the background, without changing the current tab.
  // It opens blank and navigates once it is ours, so the session's routes
  // and offline mode already apply to its first load.
  async openInBackground(url: string, opener?: Page) {
    // Called by page script: only web addresses, and none of ours.
    if (!/^https?:/i.test(url) || await internalUrlResolved(url, this.internalPorts).catch(() => 'unknown'))
      return;
    if (!this.backend)
      await this.start();
    const context = this.backend._context;
    await context.ensureBrowserContext();
    const page = await this._shared.newBackgroundPage();
    if (!await this._ownNewPage(page))
      return;
    this._adopt(context, page);
    await this._groups?.addPage(this, page).catch(() => {});
    // Told as a popup once it is on its way to the URL, as a real popup is.
    await page.goto(url, { referer: opener?.url(), waitUntil: 'commit' }).catch(() => {});
    if (opener)
      this._popupOpened(opener, page);
  }

  // A frame of this session that ended up on the DevTools port or the
  // gateway (a redirect, a page's script or link, the popup binding) is sent
  // away at once; the tools already refuse to go there.
  async _leaveInternal(frame: any) {
    const url: string = frame.url();
    const reason = await internalUrlResolved(url, this.internalPorts).catch(() => undefined);
    if (!reason)
      return;
    console.error(`${this.info.title}: left ${url} (${reason})`);
    this._notes.push(`### Navigation blocked\nA tab of yours was sent to ${url}; it was taken back to about:blank: ${reason}.`);
    await frame.goto('about:blank').catch(() => {});
  }

  // A background tab no session owns, closed when fn is done.
  async withScratchPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this._shared.newBackgroundPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // A new tab of this session in the background; the current tab stays.
  async openTab(): Promise<Page> {
    if (!this.backend)
      await this.start();
    const context = this.backend._context;
    await context.ensureBrowserContext();
    const page = await this._shared.newBackgroundPage();
    if (!await this._ownNewPage(page))
      throw new Error('This browser session has ended.');
    this._adopt(context, page);
    await this._groups?.addPage(this, page).catch(() => {});
    return page;
  }

  currentPage(): Page | undefined {
    return this.backend?._context?.currentTab()?.page;
  }

  // Set once the session has ended: a tab still being opened for it is then
  // closed as soon as it exists, instead of staying behind unowned.
  private _disposed = false;

  async _ownNewPage(page: Page) {
    if (!this._disposed)
      return true;
    await page.close().catch(() => {});
    return false;
  }

  async dispose({ closeTabs }: { closeTabs: boolean }) {
    this._disposed = true;
    const backend = this.backend;
    this.backend = undefined;
    const pages = [...this.owned, ...this._restored?.pages ?? []];
    this._restored = undefined;
    if (closeTabs) {
      for (const page of pages)
        await page.close().catch(() => {});
    }
    await this._clearNetworkState().catch(() => {});
    removeSnippetListeners(this);
    await releaseContextWide(this, this._shared.context).catch(() => {});
    await backend?.dispose().catch(() => {});
  }

  private _adopt(context: any, page: Page) {
    if (!this.owned.has(page)) {
      this.owned.add(page);
      page.once('close', () => this.owned.delete(page));
    }
    const targetId = this._shared.cachedTargetId(page);
    if (targetId) {
      this.targets.add(targetId);
    } else {
      void this._shared.targetId(page).then(id => {
        this.targets.add(id);
        this._host.onTabsChanged();
      }, () => {});
    }
    this._host.onTabsChanged();
    if (!context._tabs.some((tab: any) => tab.page === page))
      context._onPageCreated(page);
    for (const listener of this._adoptListeners)
      listener(page);
  }

  private _patchContext(context: any) {
    const session = this;
    const shared = this._shared;

    context._initializeBrowserContext = async function() {
      const browserContext = this._rawBrowserContext;
      // Popups opened by one of our tabs belong to us too.
      const onPage = async (page: Page) => {
        if (session.owned.has(page) || await shared.isGatewayCreated(page).catch(() => true))
          return;
        const opener = await page.opener().catch(() => null);
        if (opener && session.owned.has(opener)) {
          session._adopt(this, page);
          session._popupOpened(opener, page);
          await session._groups?.addPage(session, page).catch(() => {});
        }
      };
      browserContext.on('page', onPage);
      this._disposables.push({ dispose: async () => browserContext.off('page', onPage) });
      return browserContext;
    };

    context.newTab = async function() {
      await this.ensureBrowserContext();
      const page = await shared.newBackgroundPage();
      if (!await session._ownNewPage(page))
        throw new Error('This browser session has ended.');
      session._adopt(this, page);
      await session._groups?.addPage(session, page).catch(() => {});
      this._currentTab = this._tabs.find((tab: any) => tab.page === page);
      return this._currentTab;
    };

    // The stock versions of the following act on every page of the shared
    // browser context; here they act on this session's tabs only.
    context._agentSession = session;

    const upstreamStartRecording = context.startRecording.bind(context);
    context.startRecording = async function() {
      await startRecording(session, this, upstreamStartRecording);
    };
    context.stopRecording = async function() {
      return await stopRecording(session, this);
    };

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

    context.routes = () => session.routes;
    context.addRoute = async function(entry: any) {
      await this.ensureBrowserContext();
      await session.addRoute(entry);
    };
    context.removeRoute = async (pattern?: string) => await session.removeRoutes(pattern);

    context.startVideoRecording = async function(fileName: string, params: any) {
      if (this._video)
        throw new Error('Video recording has already been started.');
      this._video = { params, fileName, fileNames: [] };
      for (const tab of this._tabs)
        await this._startPageVideo(tab.page);
    };

    context.stopVideoRecording = async function() {
      if (!this._video)
        return [];
      const video = this._video;
      this._video = undefined;
      for (const page of session.owned)
        await page.screencast.stop().catch(() => {});
      return [...video.fileNames];
    };

    // Each stock Context listens for unhandled rejections process-wide and
    // hands every one to its agent: with many contexts in one process, one
    // chat's failed download showed up as an error in every other chat's next
    // result, and once no context was left (a dropped connection) the next one
    // killed the gateway. The gateway logs them instead (see gateway.ts).
    process.off('unhandledRejection', context._onUnhandledRejection);

    // New tabs of the session: tab headers that cannot hang, and offline
    // mode for navigator.onLine (routes are context-level, see addRoute).
    const onPageCreated = context._onPageCreated.bind(context);
    context._onPageCreated = function(page: Page) {
      onPageCreated(page);
      page.on('framenavigated', frame => void session._leaveInternal(frame));
      const tab = this._tabs.find((tab: any) => tab.page === page);
      if (tab)
        patchTabHeader(tab);
      if (session.offline)
        void session._emulateOffline(page, true).catch(() => {});
    };

    // Stock selectTab calls page.bringToFront(), which raises the window.
    context.selectTab = async function(index: number) {
      const tab = this._tabs[index];
      if (!tab)
        throw new Error(`Tab ${index} not found`);
      this._currentTab = tab;
      return tab;
    };
  }
}

// Every result lists the session's tabs with their titles; a page whose
// renderer is busy (an endless loop) never answers page.title(), which made
// every later call of the session hang too. Give up on the title after a while.
const headerTimeoutMs = 2000;

function patchTabHeader(tab: any) {
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
