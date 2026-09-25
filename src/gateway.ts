// HTTP MCP gateway for one profile: one shared browser, many agent sessions.
//
// An agent session is keyed by the identity the client sends (see identity.ts),
// not by the MCP transport, so a reconnecting or resumed chat gets its tabs
// back. Sessions are cleaned up when the client process is gone, when the MCP
// session is deleted, or after a long idle period.
//
// Tabs outlive the gateway's connection to the browser: when the connection
// drops (it does when a Mac's display turns off) the gateway reconnects and
// hands every session its tabs again, and sessions with tabs are saved to a
// state file so a restarted gateway finds them too.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SharedBrowser } from './browser.js';
import { TabGroups } from './groups.js';
import { applyBrowserConfig } from './config.js';
import { scopeTools } from './scoped.js';
import { AgentSession, defaultCallTimeoutSeconds, errorResult, type SessionHost, type SessionInfo } from './session.js';
import { pwTools, z, verifyInternals } from './internals.js';
import { extraTools } from './tools.js';
import { renderDashboard } from './dashboard.js';
import { openInBackgroundBinding, popupInterceptScript } from './popups.js';
import { TranscriptIndex } from './subagents.js';
import { cleanFolders, sessionFolder, subagentFolder } from './files.js';
import { baseIcon, renderDockIcon } from './docktile.js';
import { appMimeType, openTabWindowTool, tabLinkHtml, tabLinkResource, tabLinkResourceUri, tabLinkTool } from './apps.js';
import { DesktopChatFile } from './titles.js';
import { passkeyBinding, passkeyScript, type PasskeyRequest } from './passkeys.js';
import { describeRequests, holdMs, permissionBinding, permissionScript, permissionTypes, type PermissionRequest } from './permissions.js';

export type GatewayOptions = {
  profile: string;
  cdpEndpoint: string;
  port: number;
  host?: string;
  caps?: string[];
  idleTimeoutMs?: number;
  keepTabsOnExit?: boolean;
  // Root of the per-chat file folders (see files.ts).
  filesDir: string;
  // Chat folders unused this long are deleted.
  filesRetentionDays?: number;
  // Dock icon label (up to 3 characters) and its tag color; see docktile.ts.
  badge?: string;
  badgeColor?: string;
  executablePath?: string;
  dockIconCache?: string;
  // Sessions with open tabs, so a restarted gateway gives them back.
  stateFile?: string;
  // A Playwright MCP config file (JSON), for the options upstream reads there.
  configFile?: string;
};

type Transport = { transport: StreamableHTTPServerTransport; sessionKey: string };

// A browser_permission answer, re-applied after reconnecting: the browser
// forgets permissions set over a DevTools connection when it closes.
type PermissionDecision = { type: string; setting: 'granted' | 'denied'; origin: string; embeddedOrigin: string };

type SavedSession = {
  info: SessionInfo;
  filesDir?: string;
  lastActivity: number;
  startedAt: number;
  targets: string[];
  current?: string;
};

export class Gateway implements SessionHost {
  readonly options: GatewayOptions;
  readonly sessions = new Map<string, AgentSession>();
  shared!: SharedBrowser;
  groups: TabGroups | undefined;
  private _homeTargetId: string | undefined;
  private _stopping = false;
  private _transports = new Map<string, Transport>();
  private _transcripts = new Map<string, TranscriptIndex>();
  private _config: any;
  private _tools: any[] = [];
  private _server: http.Server | undefined;
  private _sweeper: NodeJS.Timeout | undefined;
  // Resolves once the browser is connected; tool calls wait for it while the
  // gateway reconnects.
  private _ready: Promise<void> = Promise.resolve();
  // Counts dropped browser connections, to tell which calls one cut off.
  private _connection = 0;
  // The connection an attach attempt is setting up, and the ones given up.
  private _attaching: Browser | undefined;
  private _abandoned = new WeakSet<Browser>();
  private _desktopChats = new Map<string, DesktopChatFile>();
  private _saveTimer: NodeJS.Timeout | undefined;
  private _permissions: PermissionDecision[] = [];

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  get baseUrl() {
    return `http://${this.options.host ?? '127.0.0.1'}:${this.options.port}`;
  }

  async start() {
    verifyInternals();
    // Also reads a Playwright MCP config file (the profile's "config") and
    // PLAYWRIGHT_MCP_* variables, as upstream does.
    this._config = await pwTools.resolveCLIConfigForMCP({
      cdpEndpoint: this.options.cdpEndpoint,
      caps: this.options.caps,
      config: this.options.configFile,
    });
    // vision: coordinate mouse tools, for canvases, maps and slider captchas.
    this._config.capabilities ??= ['devtools', 'network', 'storage', 'testing', 'vision'];
    this._tools = scopeTools([...pwTools.filteredTools(this._config), ...extraTools(this)]);
    this._server = http.createServer((req, res) => void this._handle(req, res).catch(e => {
      console.error(e);
      if (!res.headersSent)
        res.writeHead(500).end(String(e));
    }));
    await new Promise<void>(resolve => this._server!.listen(this.options.port, this.options.host ?? '127.0.0.1', resolve));
    const saved = this._loadState();
    this._permissions = this._loadPermissions();
    this._ready = this._attachBounded(saved);
    await this._ready;
    this._sweeper = setInterval(() => void this._sweep(), 15_000);
    this._sweeper.unref();
    const restored = [...this.sessions.values()].filter(s => s.owned.size);
    console.error(`[${this.options.profile}] gateway on ${this.baseUrl}/mcp, browser ${this.options.cdpEndpoint}, ` +
      `tab groups ${this.groups ? 'on' : 'off'}${restored.length ? `; restored ${restored.length} session(s) with their tabs` : ''}`);
  }

  // keepBrowser: leave the browser and every session's tabs as they are, for
  // the next gateway to pick up (a service restart). Otherwise close them.
  async stop({ keepBrowser = false } = {}) {
    this._stopping = true;
    clearInterval(this._sweeper);
    for (const { transport } of this._transports.values())
      await transport.close().catch(() => {});
    if (keepBrowser) {
      this._saveState();
    } else {
      for (const session of this.sessions.values())
        await this._closeSession(session);
    }
    this._server?.close();
    // Over CDP this only disconnects; the supervisor closes the browser.
    await this.shared?.browser.close().catch(() => {});
  }

  // Connects to the browser and sets everything up on it. Runs at startup
  // and again after the connection drops.
  private async _attach(saved?: SavedSession[]) {
    const shared = await SharedBrowser.connect(this.options.cdpEndpoint, targetId => this._onTargetDestroyed(targetId),
        connecting => this._attaching = connecting);
    shared.browser.on('disconnected', () => this._onDisconnected(shared));
    this.shared = shared;
    const groups = new TabGroups(shared);
    this.groups = await groups.init() ? groups : undefined;
    await shared.context.exposeBinding(openInBackgroundBinding, async ({ page }: { page: Page }, url: string) => {
      const owner = [...this.sessions.values()].find(session => session.owned.has(page));
      await owner?.openInBackground(url);
    });
    await shared.context.addInitScript({ content: popupInterceptScript });
    await shared.context.exposeBinding(permissionBinding, async ({ page, frame }: { page: Page; frame: any }, request: any) =>
      await this._onPermissionRequest(page, frame.url(), request));
    await shared.context.addInitScript({ content: permissionScript });
    await shared.context.exposeBinding(passkeyBinding, async ({ page, frame }: { page: Page; frame: any }, request: any) =>
      await this._onPasskeyRequest(page, frame.url(), request));
    await shared.context.addInitScript({ content: passkeyScript });
    await applyBrowserConfig(shared.context, this._config, this.baseUrl);
    for (const decision of this._permissions)
      await shared.setPermission(decision).catch(() => {});
    await this._setUpTabs(saved);
    this._dockAppliedAt = 0;
    await this._applyDockTile();
  }

  // Most setup calls have no timeout of their own: a browser that takes the
  // connection but never answers one would leave every session waiting on
  // `_ready` for good. An attempt that takes too long is given up (its
  // connection closed, so its pending calls fail) and the caller retries.
  private async _attachBounded(saved?: SavedSession[]) {
    let timer: NodeJS.Timeout | undefined;
    const attempt = this._attach(saved);
    attempt.catch(() => {});
    const stalled = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error(
        `setting up the browser connection took over ${attachTimeoutMs / 1000} s`)), attachTimeoutMs));
    try {
      await Promise.race([attempt, stalled]);
    } catch (e) {
      const connection = this._attaching;
      if (connection) {
        this._abandoned.add(connection);
        console.error(`gave up on a stalled attempt to set up the browser connection: ${(e as Error).message}`);
        await connection.close().catch(() => {});
      }
      throw e;
    } finally {
      clearTimeout(timer);
      this._attaching = undefined;
    }
  }

  // The browser itself usually lives on (it does when a Mac's display turns
  // off), so reconnect and keep every session's tabs. If it is really gone,
  // exit and let the supervisor start a new one.
  private _onDisconnected(shared: SharedBrowser) {
    if (this._stopping || shared !== this.shared || this._abandoned.has(shared.browser))
      return;
    console.error('browser connection lost; reconnecting');
    // Whether the browser dropped every DevTools client or only ours.
    setTimeout(() => console.error(`the gateway's second DevTools connection is ${shared.canaryState()}`), 1000).unref();
    this._connection++;
    for (const session of this.sessions.values())
      session.detach();
    shared.dispose();
    this._saveState();
    this._ready = this._reconnect();
  }

  private async _reconnect() {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline && !this._stopping) {
      try {
        await this._attachBounded();
        const tabs = [...this.sessions.values()].reduce((n, s) => n + s.targets.size, 0);
        console.error(`reconnected to the browser; ${tabs} agent tab(s) kept`);
        return;
      } catch (e) {
        lastError = e;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.error(`Could not reconnect to the browser (${(lastError as Error)?.message}); exiting so the supervisor can restart the gateway.`);
    process.exit(1);
  }

  // The status page is the one tab no agent owns: it keeps the window alive
  // when all agents have closed theirs, and shows who is working when the
  // user opens the window. The window is minimized on startup.
  // Tabs of known sessions (after a reconnect, or saved before a restart) go
  // back to their sessions; anything else is an orphan from an earlier run
  // (or a window Chrome restored) and is closed. One window keeps every
  // session's tabs, and so its tab group, together.
  private async _setUpTabs(saved?: SavedSession[]) {
    const pages = this.shared.context.pages();
    const byTarget = new Map<string, Page>();
    for (const page of pages) {
      const id = await this.shared.targetId(page).catch(() => undefined);
      if (id)
        byTarget.set(id, page);
    }
    for (const entry of saved ?? []) {
      if (!entry.targets.some(id => byTarget.has(id)))
        continue;
      if (entry.info.pid !== undefined && !isAlive(entry.info.pid))
        continue;
      // The chat may have reconnected already, while the gateway was starting.
      let session = this.sessions.get(entry.info.id);
      if (session?.started)
        continue;
      if (!session) {
        session = new AgentSession(entry.info, this, this._config, this._tools, this._retentionDays);
        this.sessions.set(entry.info.id, session);
      }
      session.filesDir = entry.filesDir;
      session.startedAt = entry.startedAt;
      entry.targets.forEach(id => session.targets.add(id));
      session.currentTarget = entry.current;
      session.lastActivity = entry.lastActivity;
    }
    const kept = new Set<string>();
    for (const session of this.sessions.values()) {
      session.restore(byTarget);
      session.targets.forEach(id => kept.add(id));
    }
    const homeId = [...byTarget].find(([, page]) => page.url().startsWith(this.baseUrl))?.[0]
      ?? [...byTarget.keys()].find(id => !kept.has(id));
    // With --no-startup-window there may be no window yet.
    const home = homeId ? byTarget.get(homeId)! : await this.shared.newBackgroundPage(this.baseUrl, true);
    for (const [id, page] of byTarget) {
      if (page !== home && !kept.has(id))
        await page.close().catch(() => {});
    }
    await this._adoptHome(home);
    await this.shared.startFocusGuard(this._homeTargetId!);
    this._saveState();
  }

  private async _adoptHome(home: Page) {
    if (!home.url().startsWith(this.baseUrl))
      await home.goto(this.baseUrl).catch(() => {});
    await this.groups?.pin(home).catch(() => {});
    this._homeTargetId = await this.shared.targetId(home);
    this.shared.setHomeTarget(this._homeTargetId);
    await this.shared.hideApp();
  }

  // A tab really closed (not just a dropped connection).
  private _onTargetDestroyed(targetId: string) {
    let changed = false;
    for (const session of this.sessions.values())
      changed = session.targets.delete(targetId) || changed;
    if (changed)
      this.onTabsChanged();
    // Closing the window (red button) closes every tab in it; put a fresh,
    // hidden window back so agents have somewhere to open tabs.
    if (targetId === this._homeTargetId && !this._stopping) {
      console.error('browser window was closed; creating a new hidden one');
      this._homeTargetId = undefined;
      const shared = this.shared;
      void shared.newBackgroundPage(this.baseUrl, true).then(async page => {
        if (shared === this.shared)
          await this._adoptHome(page);
      }).catch(e => console.error(e));
    }
  }

  // SessionHost
  filesFolder(session: AgentSession): string {
    const [rootId, sub] = session.info.id.split('#');
    if (sub === undefined)
      return sessionFolder(this.options.filesDir, session.info.id);
    const root = this.sessions.get(rootId);
    return subagentFolder(root ? root.ensureFilesDir() : sessionFolder(this.options.filesDir, rootId), sub);
  }

  onSessionStarted(session: AgentSession) {
    session.startedAt = Date.now();
    this._refreshTitles();
    console.error(`session started: ${session.info.title} (${session.info.id}${session.info.pid ? `, pid ${session.info.pid}` : ''})`);
  }

  onTabsChanged() {
    if (this._saveTimer)
      return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined;
      this._saveState();
    }, 1000);
    this._saveTimer.unref();
  }

  private _saveState() {
    const file = this.options.stateFile;
    if (!file)
      return;
    const sessions: SavedSession[] = [...this.sessions.values()].filter(s => s.targets.size).map(s => ({
      info: s.info,
      filesDir: s.filesDir,
      lastActivity: s.lastActivity,
      startedAt: s.startedAt,
      targets: [...s.targets],
      current: s.currentTargetId(),
    }));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, sessions, permissions: this._permissions }, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.error(`could not save sessions: ${(e as Error).message}`);
    }
  }

  private _loadPermissions(): PermissionDecision[] {
    if (!this.options.stateFile)
      return [];
    try {
      const state = JSON.parse(fs.readFileSync(this.options.stateFile, 'utf8'));
      return Array.isArray(state?.permissions) ? state.permissions : [];
    } catch {
      return [];
    }
  }

  // A page asks for a permission (see permissions.ts). Resolving the returned
  // promise lets the page go on to ask the browser.
  private async _onPermissionRequest(page: Page, frameUrl: string, raw: any) {
    const owner = [...this.sessions.values()].find(session => session.owned.has(page));
    const permissions = Array.isArray(raw?.permissions) ? raw.permissions.filter((p: unknown) => typeof p === 'string' && p in permissionTypes) : [];
    if (!owner || !permissions.length)
      return;
    const origin = safeOrigin(page.url());
    const frameOrigin = safeOrigin(frameUrl) || origin;
    const decided = (name: string) => this._permissions.find(d => d.type === permissionTypes[name][0] && d.origin === origin && d.embeddedOrigin === frameOrigin)?.setting;
    // Decided before: the browser answers by itself.
    if (permissions.every((name: string) => decided(name) === 'granted'))
      return;
    const refusedBefore = permissions.some((name: string) => decided(name) === 'denied');
    const hold = !!raw.hold && !refusedBefore;
    const request: PermissionRequest = {
      page,
      tab: (await this.shared.targetId(page).catch(() => '')).slice(0, 8),
      origin,
      frameOrigin,
      permissions,
      api: String(raw.api ?? ''),
      waiting: hold,
      status: hold ? 'pending' : 'refused',
      announced: false,
      at: Date.now(),
    };
    owner.permissionRequests.push(request);
    console.error(`permission request in ${owner.info.title}: ${request.frameOrigin} asks for ${permissions.join(', ')}${hold ? '' : ' (refused, reported)'}`);
    if (!request.waiting)
      return;
    await new Promise<void>(resolve => {
      request.resolve = resolve;
      setTimeout(() => {
        if (request.status === 'pending') {
          request.status = 'timed out';
          request.announced = false;
          resolve();
        }
      }, holdMs).unref();
    });
  }

  // SessionHost: a chat forked in the Claude desktop app starts with copies of
  // the original chat's tabs (the originals stay with that chat). Copies are
  // made when the fork first uses the browser, like the browser's "Duplicate"
  // command, so history and sessionStorage come along.
  async copyForkedTabs(session: AgentSession): Promise<string | undefined> {
    if (session.info.id.includes('#') || !session.info.desktopChat)
      return undefined;
    const forkedFrom = this._desktopChatFile(session.info.desktopChat).read()?.forkedFrom;
    if (!forkedFrom)
      return undefined;
    const original = [...this.sessions.values()].find(s => s !== session && !s.info.id.includes('#') &&
        (s.info.desktopChat === forkedFrom || s.info.id === forkedFrom));
    if (!original?.targets.size)
      return undefined;
    const current = original.currentTargetId();
    const copies: { page: Page; current: boolean }[] = [];
    const failed: string[] = [];
    for (const targetId of original.targets) {
      try {
        // A browser started before the extension could duplicate tabs keeps
        // the old extension until it restarts: open the same URL then.
        const page = this.groups
          ? await this.shared.createdPage(this.groups.duplicate(targetId)).catch(() => this._copyByUrl(targetId))
          : await this._copyByUrl(targetId);
        copies.push({ page, current: targetId === current });
      } catch (e) {
        failed.push(`${targetId.slice(0, 8)} (${(e as Error).message})`);
      }
    }
    await session.adoptCopies(copies);
    console.error(`fork ${session.info.title}: copied ${copies.length} tab(s) of ${original.info.title}${failed.length ? `, failed: ${failed.join(', ')}` : ''}`);
    const ids = await Promise.all(copies.map(async c => (await this.shared.targetId(c.page)).slice(0, 8) + (c.current ? ' (current)' : '')));
    return `### Tabs of the original chat\nThis chat is a fork of "${original.info.title}". Its tabs were copied into your ` +
      `group: ${ids.join(', ') || 'none'}${failed.length ? `; could not copy ${failed.join(', ')}` : ''}. The original tabs stay ` +
      'with that chat. The copies are fresh loads of the same pages (history kept): what a page held only in memory is ' +
      'gone, and pages that act when loaded (payments, one-time links, form results) may repeat that or show an error. ' +
      'Take a snapshot before acting.';
  }

  // Without the extension's "Duplicate": open the same URL (no history or
  // sessionStorage).
  private async _copyByUrl(targetId: string): Promise<Page> {
    const page = await this.shared.pageByTargetId(targetId);
    if (!page)
      throw new Error('tab not found');
    return await this.shared.newBackgroundPage(page.url());
  }

  private _desktopChatFile(desktopChat: string) {
    let file = this._desktopChats.get(desktopChat);
    if (!file)
      this._desktopChats.set(desktopChat, file = new DesktopChatFile(desktopChat));
    return file;
  }

  // A page asks for a passkey (see passkeys.ts): 'cancel' when nobody can see
  // the browser to answer the prompt, else 'proceed'.
  private async _onPasskeyRequest(page: Page, frameUrl: string, raw: any): Promise<'cancel' | 'proceed'> {
    const owner = [...this.sessions.values()].find(session => session.owned.has(page));
    const kind = raw?.kind === 'create' ? 'create' : 'get';
    const visible = await this.shared.userCanSee(page).catch(() => false);
    const request: PasskeyRequest = {
      page,
      tab: (await this.shared.targetId(page).catch(() => '')).slice(0, 8),
      origin: safeOrigin(page.url()),
      frameOrigin: safeOrigin(frameUrl) || safeOrigin(page.url()),
      kind,
      cancelled: !visible,
    };
    owner?.passkeyRequests.push(request);
    console.error(`passkey request (${kind}) in ${owner?.info.title ?? 'an unowned tab'}: ${request.frameOrigin}${visible ? ' (window in front, passed on)' : ' (cancelled)'}`);
    return visible ? 'proceed' : 'cancel';
  }

  // SessionHost: what the agent should hear about in its next tool result.
  permissionNotes(session: AgentSession): string | undefined {
    const open = session.permissionRequests.filter(r => r.status === 'pending' || !r.announced);
    const text = describeRequests(open);
    for (const r of open)
      r.announced = true;
    // Refused requests stay answerable for a while after the agent was told.
    session.permissionRequests = session.permissionRequests.filter(r => r.status === 'pending' || Date.now() - r.at < 10 * 60 * 1000);
    return text;
  }

  // browser_permission: sets the permissions for a site and answers the
  // session's matching requests.
  async answerPermissions(session: AgentSession, decision: 'allow' | 'deny', names: string[] | undefined, origin: string | undefined, currentPage: Page | undefined) {
    const unknown = (names ?? []).filter(name => !(name in permissionTypes));
    if (unknown.length)
      throw new Error(`Unknown permission ${unknown.join(', ')}. Known: ${Object.keys(permissionTypes).join(', ')}`);
    const matching = session.permissionRequests.filter(r => r.status === 'pending' || r.status === 'refused' || r.status === 'timed out')
        .filter(r => (!names || r.permissions.some(p => names.includes(p))) && (!origin || r.origin === origin || r.frameOrigin === origin));
    const targets = matching.map(r => ({ origin: r.origin, frameOrigin: r.frameOrigin, permissions: names ? r.permissions.filter(p => names.includes(p)) : r.permissions }));
    if (!targets.length) {
      const pageOrigin = origin ?? safeOrigin(currentPage?.url() ?? '');
      if (!names?.length || !pageOrigin)
        throw new Error('No permission request to answer. To set a permission ahead of time, pass permissions (and origin, or open the site first).');
      targets.push({ origin: pageOrigin, frameOrigin: pageOrigin, permissions: names });
    }
    const setting = decision === 'allow' ? 'granted' : 'denied';
    const done = new Set<string>();
    for (const target of targets) {
      for (const name of target.permissions) {
        for (const type of permissionTypes[name]) {
          const entry: PermissionDecision = { type, setting, origin: target.origin, embeddedOrigin: target.frameOrigin };
          await this.shared.setPermission(entry).catch(e => console.error(`permission ${type}: ${(e as Error).message}`));
          this._permissions = this._permissions.filter(d => !(d.type === type && d.origin === entry.origin && d.embeddedOrigin === entry.embeddedOrigin));
          this._permissions.push(entry);
        }
        done.add(`${name} for ${target.frameOrigin}`);
      }
    }
    for (const request of matching) {
      const wasPending = request.status === 'pending';
      request.status = decision === 'allow' ? 'allowed' : 'denied';
      request.announced = true;
      if (wasPending)
        request.resolve?.();
    }
    session.permissionRequests = session.permissionRequests.filter(r => !matching.includes(r));
    this._saveState();
    console.error(`permissions ${decision === 'allow' ? 'allowed' : 'denied'} by ${session.info.title}: ${[...done].join('; ')}`);
    const waited = matching.filter(r => r.waiting).length;
    return `${decision === 'allow' ? 'Allowed' : 'Denied'}: ${[...done].join('; ')}.` +
      (waited ? ' Waiting requests got their answer.' : '') +
      (decision === 'allow' && matching.some(r => !r.waiting || r.status !== 'allowed') ? ' Repeat the action that asked for it if the page did not get it.' : '');
  }

  private _loadState(): SavedSession[] | undefined {
    if (!this.options.stateFile)
      return undefined;
    try {
      const state = JSON.parse(fs.readFileSync(this.options.stateFile, 'utf8'));
      return Array.isArray(state?.sessions) ? state.sessions : undefined;
    } catch {
      return undefined;
    }
  }

  // Tab group titles follow the chat's title: the desktop app's chat title,
  // or a title set with /rename in the CLI; otherwise what the client sent.
  // Chats with the same title are told apart with a number.
  private _refreshTitles() {
    const active = new Set([...this.sessions.values()].filter(s => s.started).map(s => s.info.id.split('#')[0]));
    const roots = [...active].map(id => this.sessions.get(id)).filter((s): s is AgentSession => !!s)
        .sort((a, b) => a.startedAt - b.startedAt);
    const seen = new Map<string, number>();
    const titles = new Map<string, string>();
    for (const root of roots) {
      const base = (this._chatTitle(root) ?? root.info.fallbackTitle ?? root.info.title).slice(0, 56);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      titles.set(root.info.id, n > 1 ? `${base} (${n})` : base);
    }
    for (const session of this.sessions.values()) {
      const [rootId, sub] = session.info.id.split('#');
      const rootTitle = titles.get(rootId);
      if (!rootTitle)
        continue;
      const title = sub === undefined ? rootTitle : `${rootTitle} · ${session.info.label ?? sub}`.slice(0, 60);
      if (title === session.info.title)
        continue;
      if (session.targets.size)
        console.error(`session renamed: ${session.info.title} -> ${title}`);
      session.info.title = title;
      void this.groups?.rename(session).catch(() => {});
      this.onTabsChanged();
    }
  }

  private _chatTitle(root: AgentSession): string | undefined {
    const { desktopChat, claudeSessionId, configDir } = root.info;
    if (desktopChat) {
      const title = this._desktopChatFile(desktopChat).read()?.title;
      if (title)
        return title;
    }
    if (claudeSessionId && configDir)
      return this._transcriptIndex(root)?.customTitle();
    return undefined;
  }

  private _transcriptIndex(root: AgentSession) {
    const { claudeSessionId, configDir } = root.info;
    if (!claudeSessionId || !configDir)
      return undefined;
    let index = this._transcripts.get(root.info.id);
    if (!index) {
      index = new TranscriptIndex(configDir, claudeSessionId, () => this._refreshTitles());
      this._transcripts.set(root.info.id, index);
    }
    return index;
  }

  toolSchemas() {
    return this._tools.map(tool => {
      const readOnly = tool.schema.type === 'readOnly' || tool.schema.type === 'assertion';
      const inputSchema = z.toJSONSchema(tool.schema.inputSchema);
      inputSchema.properties = {
        ...inputSchema.properties,
        tab: { type: 'string', description: 'Id of one of your tabs (from browser_tabs) to act on instead of the current tab.' },
        agent: { type: 'string', description: `Only if you called ${subagentTool.name}: the id it gave you.` },
        timeout: { type: 'number', description: `Seconds after which this call is given up so it cannot block your next calls ` +
          `(default ${defaultCallTimeoutSeconds}; browser_wait_for adds its own wait). Raise it only for calls that really take longer.` },
      };
      return {
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema,
        annotations: { title: tool.schema.title, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
      };
    }).concat([subagentTool, tabLinkTool, openTabWindowTool] as any[]);
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.baseUrl);
    if (url.pathname === '/mcp')
      return await this._handleMcp(req, res);
    if (url.pathname === '/focus') {
      await this._ready;
      return await this._handleFocus(url, res);
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(this));
      return;
    }
    res.writeHead(404).end('Not found');
  }

  private async _handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    if (mcpSessionId) {
      const entry = this._transports.get(mcpSessionId);
      if (!entry) {
        res.writeHead(404).end('Session not found');
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(400).end('Invalid request');
      return;
    }
    const body = await readJson(req);
    if (!isInitializeRequest(body)) {
      res.writeHead(400).end('Expected an initialize request');
      return;
    }
    const info = sessionInfoFromHeaders(req.headers, body.params?.clientInfo?.name);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: id => {
        this._transports.set(id, { transport, sessionKey: info.id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId)
        this._transports.delete(transport.sessionId);
    };
    const session = this._sessionFor(info);
    const server = this._createServer(session);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private _sessionFor(info: SessionInfo) {
    let session = this.sessions.get(info.id);
    if (session) {
      // Same agent reconnecting (MCP reconnect, resumed chat): keep its tabs.
      Object.assign(session.info, {
        pid: info.pid ?? session.info.pid,
        cwd: info.cwd ?? session.info.cwd,
        claudeSessionId: info.claudeSessionId ?? session.info.claudeSessionId,
        configDir: info.configDir ?? session.info.configDir,
        desktopChat: info.desktopChat ?? session.info.desktopChat,
        fallbackTitle: info.fallbackTitle,
      });
      if (session.started)
        this._refreshTitles();
      return session;
    }
    // Nothing is created in the browser or on disk until the chat actually
    // uses the browser (AgentSession.start).
    session = new AgentSession(info, this, this._config, this._tools, this._retentionDays);
    this.sessions.set(info.id, session);
    return session;
  }

  private _createServer(session: AgentSession) {
    const server = new Server({ name: 'agentic-playwright-mcp', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.toolSchemas() }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      console.error(`resources/list from ${session.info.title}`);
      return { resources: [tabLinkResource] };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async request => {
      console.error(`resources/read ${request.params.uri} from ${session.info.title}`);
      if (request.params.uri !== tabLinkResourceUri)
        throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: tabLinkResourceUri, mimeType: appMimeType, text: tabLinkHtml }] };
    });
    // Upstream turns a failing tool into an error result the agent can read;
    // anything thrown on the gateway's own path would otherwise reach it as a
    // bare JSON-RPC error. A call the agent cancelled stays a cancellation.
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        return await this._dispatch(session, request, extra);
      } catch (e) {
        if (extra.signal.aborted)
          throw e;
        console.error(`${request.params.name} from ${session.info.title} failed: ${(e as Error).stack ?? e}`);
        return errorResult(String((e as Error).message ?? e));
      }
    });
    return server;
  }

  private async _dispatch(session: AgentSession, request: any, extra: any) {
    {
      await untilAborted(this._ready, extra.signal);
      const { agent, ...args } = (request.params.arguments ?? {}) as Record<string, any>;
      if (request.params.name === subagentTool.name)
        return this._startSubagent(session, String(args.label ?? 'subagent'));
      const toolUseId = (request.params._meta as any)?.['claudecode/toolUseId'];
      const target = agent === undefined
        ? await this._autoTarget(session, toolUseId)
        : this.sessions.get(`${session.info.id}#${agent}`);
      if (!target)
        return errorResult(`Unknown agent "${agent}". Call ${subagentTool.name} first and pass the id it returns.`);
      if (request.params.name === tabLinkTool.name)
        return await this._tabLink(target, args.index);
      if (request.params.name === openTabWindowTool.name) {
        console.error(`tab link button clicked in ${session.info.title}`);
        return await this._openTabWindow(String(args.targetId ?? ''));
      }
      return await this._callWithRetry(target, request.params.name, args, extra.signal);
    }
  }

  // A call that was running when the browser connection dropped fails (its
  // page objects are gone) although nothing is wrong with the agent's request.
  // Calls that change nothing are repeated once the gateway has reconnected;
  // for the others the agent is told what happened, since the action may or
  // may not have taken effect.
  private async _callWithRetry(session: AgentSession, name: string, args: any, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      const generation = this._connection;
      let result: any;
      try {
        result = await session.callTool(name, args, signal);
      } catch (e) {
        if (generation === this._connection)
          throw e;
      }
      if (generation === this._connection)
        return result;
      await this._ready;
      if (attempt === 0 && isSafeToRepeat(this._tools, name, args)) {
        console.error(`${name} from ${session.info.title} was cut off by the reconnect; repeating it`);
        continue;
      }
      return errorResult('The connection to the browser dropped while this call ran and has been restored; your tabs ' +
        'are still open. The action may or may not have taken effect: check the page (browser_snapshot) before repeating it.');
    }
  }

  // Claude Code subagents are recognized from the chat's transcripts, so they
  // get their own sub-session without passing anything.
  private async _autoTarget(session: AgentSession, toolUseId: unknown): Promise<AgentSession> {
    if (typeof toolUseId !== 'string')
      return session;
    const caller = await this._transcriptIndex(session)?.lookup(toolUseId).catch(() => undefined);
    if (caller?.kind !== 'subagent')
      return session;
    const id = `${session.info.id}#${caller.agentId}`;
    let sub = this.sessions.get(id);
    if (!sub) {
      const info: SessionInfo = { id, title: `${session.info.title} · ${caller.description}`.slice(0, 60), label: caller.description, pid: session.info.pid, cwd: session.info.cwd };
      sub = new AgentSession(info, this, this._config, this._tools, this._retentionDays);
      this.sessions.set(id, sub);
    }
    return sub;
  }

  private async _tabLink(session: AgentSession, index: unknown) {
    const context = session.backend?._context;
    const tab = index === undefined ? context?.currentTab() : context?.tabs()[Number(index)];
    if (!tab)
      return errorResult('No such tab. Open a page first (browser_navigate), then call this again.');
    const targetId = await this.shared.targetId(tab.page);
    const url = tab.page.url();
    const title = await tab.page.title().catch(() => '');
    const link = `${this.baseUrl}/focus?target=${targetId}`;
    // Claude Code shows the model structuredContent instead of the text, so the
    // link and what to do with it are in both.
    const instruction = `Give the user this link as a markdown link, e.g. [Open "${title || url}" in the agent browser](${link}). ` +
      'Clicking it brings the agent browser window to the front on this tab.';
    return {
      content: [{ type: 'text' as const, text: instruction }],
      structuredContent: { link, instruction, targetId, url, title, profile: this.options.profile },
    };
  }

  private async _openTabWindow(targetId: string) {
    if (!targetId || !await this.shared.pageByTargetId(targetId))
      return errorResult('That tab is closed.');
    await this.shared.focusTab(targetId);
    return { content: [{ type: 'text' as const, text: 'Opened.' }] };
  }

  // A subagent gets its own sub-session: its own tabs, tab group and current
  // tab, so parallel subagents of one chat neither see nor wait for each other.
  // The gateway picks the id, so two subagents can never collide.
  private _startSubagent(parent: AgentSession, label: string) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'subagent';
    let handle: string;
    do
      handle = `${slug}-${++parent.subagentCount}`;
    while (this.sessions.has(`${parent.info.id}#${handle}`));
    const info: SessionInfo = {
      id: `${parent.info.id}#${handle}`,
      title: `${parent.info.title} · ${label}`.slice(0, 60),
      label,
      pid: parent.info.pid,
      cwd: parent.info.cwd,
    };
    this.sessions.set(info.id, new AgentSession(info, this, this._config, this._tools, this._retentionDays));
    return { content: [{ type: 'text', text: `Your agent id is "${handle}". Pass "agent": "${handle}" in every browser call; ` +
      'your tabs live in their own tab group and other agents cannot see them.' }] };
  }

  // /focus?target=<id> is opened by a click on a link in a chat, i.e. in the
  // user's everyday browser, which comes to the front while it loads the page.
  // Activating our window right away loses that race, so the page itself asks
  // for the switch (…&go=1) once it is showing, then closes itself.
  // go=1 is also what the CLI and the agentic-browser:// handler call directly.
  private async _handleFocus(url: URL, res: http.ServerResponse) {
    const target = url.searchParams.get('home') ? this._homeTargetId : url.searchParams.get('target');
    if (!url.searchParams.get('go')) {
      const go = new URL(url);
      go.searchParams.set('go', '1');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Opening the agent browser…</title><p>Opening the agent browser…</p>` +
        `<script>setTimeout(async () => { await fetch(${JSON.stringify(go.pathname + go.search)}); window.close(); }, 200)</script>`);
      return;
    }
    try {
      if (!target)
        throw new Error('missing ?target=');
      await this.shared.focusTab(target);
      // Closes itself if someone opened the go=1 URL in a browser directly.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Opened</title><script>window.close()</script>');
    } catch (e) {
      res.writeHead(500).end(`Could not open the tab: ${(e as Error).message}`);
    }
  }

  private _isBound(session: AgentSession) {
    const rootId = session.info.id.split('#')[0];
    for (const { sessionKey } of this._transports.values()) {
      if (sessionKey === rootId)
        return true;
    }
    return false;
  }

  private get _retentionDays() {
    return this.options.filesRetentionDays ?? 7;
  }

  private _filesSweptAt = 0;
  private _dockImage: string | undefined;
  private _dockAppliedAt = 0;

  // Chrome may redraw its own Dock icon (downloads, restarts of the tile), so
  // the image is rendered once and re-applied now and then.
  private async _applyDockTile() {
    const { badge, badgeColor, executablePath, dockIconCache } = this.options;
    if (!badge || !executablePath || !dockIconCache || await this.shared.isHeadless())
      return;
    try {
      if (!this._dockImage) {
        const icon = baseIcon(executablePath, dockIconCache);
        const worker = await this.groups?.extensionWorker();
        if (!icon || !worker)
          return;
        this._dockImage = await renderDockIcon(worker, icon, badge, badgeColor ?? '#d93025');
      }
      await this.shared.setDockTile(this._dockImage);
      this._dockAppliedAt = Date.now();
    } catch (e) {
      console.error(`dock icon: ${(e as Error).message}`);
    }
  }

  private async _sweep() {
    const now = Date.now();
    if (now - this._dockAppliedAt > 60 * 1000)
      await this._applyDockTile();
    this._refreshTitles();
    if (now - this._filesSweptAt > 60 * 60 * 1000) {
      this._filesSweptAt = now;
      const inUse = new Set([...this.sessions.values()].map(s => s.filesDir).filter((dir): dir is string => !!dir));
      for (const name of cleanFolders(this.options.filesDir, this._retentionDays * 24 * 60 * 60 * 1000, inUse))
        console.error(`files: deleted ${name} (unused for ${this._retentionDays} days)`);
    }
    const idleTimeout = this.options.idleTimeoutMs ?? 24 * 60 * 60 * 1000;
    for (const session of [...this.sessions.values()]) {
      if (!this.sessions.has(session.info.id))
        continue;
      const processGone = session.info.pid !== undefined && !isAlive(session.info.pid);
      const idle = now - session.lastActivity > idleTimeout;
      const unboundWithoutPid = session.info.pid === undefined && !this._isBound(session) && now - session.lastActivity > 5 * 60 * 1000;
      if (processGone || idle || unboundWithoutPid)
        await this._closeSession(session);
    }
  }

  async _closeSession(session: AgentSession) {
    for (const child of [...this.sessions.values()]) {
      if (child.info.id.startsWith(`${session.info.id}#`))
        await this._closeSession(child);
    }
    if (session.started)
      console.error(`session closed: ${session.info.title} (${session.targets.size} tab(s))`);
    this.sessions.delete(session.info.id);
    this._transcripts.delete(session.info.id);
    const chat = session.info.desktopChat;
    if (chat && ![...this.sessions.values()].some(s => s.info.desktopChat === chat))
      this._desktopChats.delete(chat);
    for (const [id, entry] of this._transports) {
      if (entry.sessionKey === session.info.id) {
        this._transports.delete(id);
        await entry.transport.close().catch(() => {});
      }
    }
    await session.dispose({ closeTabs: !this.options.keepTabsOnExit });
    await this.groups?.forget(session);
    this.onTabsChanged();
  }
}

const subagentTool = {
  name: 'browser_subagent_start',
  description: 'Only for clients other than Claude Code (Claude Code subagents are recognized automatically). ' +
    'A subagent calls this once to get its own tab group, separate from the main chat and other subagents; it ' +
    'returns an agent id to pass as "agent" in every other browser call.',
  inputSchema: {
    type: 'object',
    properties: { label: { type: 'string', description: 'Short name of your task, shown in the tab group title, e.g. "pricing research".' } },
    required: ['label'],
  },
  annotations: { title: 'Start a subagent browser session', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

// Calls that only read, or that land in the same state when repeated.
function isSafeToRepeat(tools: any[], name: string, args: any) {
  if (name === 'browser_navigate' || (name === 'browser_tabs' && ['list', 'select'].includes(args?.action)))
    return true;
  const type = tools.find(tool => tool.schema.name === name)?.schema.type;
  // Recording, tracing and video calls start or stop something.
  return (type === 'readOnly' || type === 'assertion') && !/_(recording|tracing|video)|video_/.test(name);
}


export function sessionInfoFromHeaders(headers: http.IncomingHttpHeaders, clientName?: string): SessionInfo {
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' && value ? decodeURIComponent(value) : undefined;
  };
  const id = header('x-agent-session-id') ?? `anon-${crypto.randomUUID().slice(0, 8)}`;
  const pid = Number(header('x-agent-pid')) || undefined;
  const title = header('x-agent-title') ?? `${clientName ?? 'agent'} ${id.slice(-6)}`;
  return {
    id,
    pid,
    cwd: header('x-agent-cwd'),
    claudeSessionId: header('x-agent-claude-session'),
    configDir: header('x-agent-config-dir'),
    desktopChat: header('x-agent-desktop-chat'),
    title,
    fallbackTitle: title,
  };
}

function safeOrigin(url: string) {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

// Longest time one attempt to set up the browser connection may take.
const attachTimeoutMs = 15_000;

// Waits for `promise`, or rejects as soon as the agent cancels the call.
async function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return await promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}
