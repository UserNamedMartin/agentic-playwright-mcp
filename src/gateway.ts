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
//
// Each session's Playwright reaches the browser through the proxy (proxy.ts),
// which shows it only its own tabs; the gateway itself sees the whole browser
// through one raw DevTools connection (browser.ts). Who owns which tab is kept
// here (`owners`), by target id.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type PageCall, SharedBrowser } from './browser.js';
import type { CdpConnection } from './cdp.js';
import { TabGroups } from './groups.js';
import { linkToken, readLinkSecret } from './linktoken.js';
import { CdpProxy, type ProxyHost } from './proxy.js';
import { scopeTools } from './scoped.js';
import { type SavedNetworkState, AgentSession, defaultCallTimeoutSeconds, errorResult, profilePorts, type SessionHost, type SessionInfo } from './session.js';
import { pwTools, z, verifyInternals } from './internals.js';
import { installNetGuard } from './netguard.js';
import { extraTools } from './tools.js';
import { renderDashboard } from './dashboard.js';
import { popupInterceptScript } from './popups.js';
import { TranscriptIndex } from './subagents.js';
import { cleanFolders, cleanOldEntries, sessionFolder, subagentFolder } from './files.js';
import { baseIcon, renderDockIcon } from './docktile.js';
import { appMimeType, openTabWindowTool, tabLinkHtml, tabLinkResource, tabLinkResourceUri, tabLinkTool } from './apps.js';
import { DesktopChatFile } from './titles.js';
import { passkeyScript, type PasskeyRequest } from './passkeys.js';
import { describeRequests, holdMs, permissionScript, permissionTypes, type PermissionRequest } from './permissions.js';

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
  // Where the browser saves downloads by itself (see launcher.ts); what is
  // there is deleted after the same time.
  browserDownloadsDir?: string;
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
  network?: SavedNetworkState;
};

export class Gateway implements SessionHost, ProxyHost {
  readonly options: GatewayOptions;
  readonly sessions = new Map<string, AgentSession>();
  // Who owns which tab: session key by target id. Kept across reconnects.
  readonly owners = new Map<string, string>();
  shared!: SharedBrowser;
  groups: TabGroups | undefined;
  proxy!: CdpProxy;
  private _homeTargetId: string | undefined;
  private _stopping = false;
  private _transports = new Map<string, Transport>();
  private _transcripts = new Map<string, TranscriptIndex>();
  private _config: any;
  private _tools: any[] = [];
  private _server: http.Server | undefined;
  private _ipcServer: http.Server | undefined;
  private _socketPath = '';
  private _sweeper: NodeJS.Timeout | undefined;
  // Resolves once the browser is connected; tool calls wait for it while the
  // gateway reconnects.
  private _ready: Promise<void> = Promise.resolve();
  // Counts dropped browser connections, to tell which calls one cut off.
  private _connection = 0;
  // The connection an attach attempt is setting up, and the ones given up.
  private _attaching: CdpConnection | undefined;
  private _abandoned = new WeakSet<CdpConnection>();
  private _desktopChats = new Map<string, DesktopChatFile>();
  private _saveTimer: NodeJS.Timeout | undefined;
  private _permissions: PermissionDecision[] = [];

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  get baseUrl() {
    return `http://${this.options.host ?? '127.0.0.1'}:${this.options.port}`;
  }

  get cdpEndpoint() {
    return this.options.cdpEndpoint;
  }

  // Signs tab links (see linktoken.ts); kept in the profile's folder.
  private get _linkSecret() {
    return this.__linkSecret ??= readLinkSecret(this.options.profile, true)!;
  }
  private __linkSecret: string | undefined;

  // The status page lists every chat with its tabs' URLs, for the user. It
  // is not served over HTTP (anything can reach the gateway's address: an
  // agent's tab by redirect, a page's request): the gateway writes it into
  // the pinned home tab over DevTools, whose own URL shows only a note.
  get statusUrl() {
    return `${this.baseUrl}/`;
  }

  private _homeTimer: NodeJS.Timeout | undefined;

  private _renderHome() {
    if (this._homeTargetId && this.shared?.info(this._homeTargetId))
      void this.shared.setContent(this._homeTargetId, renderDashboard(this)).catch(() => {});
  }

  // ProxyHost: a session's tab was sent to an internal address and taken back.
  onNavigationBlocked(key: string, url: string, reason: string) {
    this.sessions.get(key)?.note(`### Navigation blocked\nA tab of yours was sent to ${url}; it was taken back to about:blank: ${reason}.`);
  }

  // Ports agents may not reach: this gateway's, its browser's, and every
  // other profile's (see urls.ts).
  internalPorts(): string[] {
    return [String(this.options.port), new URL(this.options.cdpEndpoint).port, ...profilePorts()];
  }

  async start() {
    verifyInternals();
    installNetGuard();
    // Playwright leaves some promises unhandled (a download whose page went
    // away when the browser connection dropped). Upstream every agent's
    // context catches them; the gateway serves many agents and only logs
    // them rather than let one kill the process for everyone.
    if (!process.listeners('unhandledRejection').includes(logUnhandledRejection))
      process.on('unhandledRejection', logUnhandledRejection);
    // Also reads a Playwright MCP config file (the profile's "config") and
    // PLAYWRIGHT_MCP_* variables, as upstream does.
    this._config = await pwTools.resolveCLIConfigForMCP({
      cdpEndpoint: this.options.cdpEndpoint,
      caps: this.options.caps,
      config: this.options.configFile,
    });
    // vision: coordinate mouse tools, for canvases, maps and slider captchas.
    // pdf: works in the headed browser too (Page.printToPDF). Not "config":
    // browser_get_config would print the config's secrets to the agent.
    this._config.capabilities ??= ['devtools', 'network', 'storage', 'testing', 'vision', 'pdf'];
    // browser_annotate opens the Playwright Dashboard, a separate visible
    // browser waiting for the user, which does not see this gateway's
    // connection and outlives it.
    this._tools = scopeTools([...pwTools.filteredTools(this._config), ...extraTools()])
        .filter(tool => tool.schema.name !== 'browser_annotate');
    // The browser saves every download here first (see proxy.ts).
    const downloadsDir = path.join(path.dirname(this.options.filesDir), 'downloads');
    fs.rmSync(downloadsDir, { recursive: true, force: true });
    fs.mkdirSync(downloadsDir, { recursive: true });
    // Sessions' Playwright connections come in over a socket file (see proxy.ts).
    this._socketPath = path.join(os.tmpdir(), `agentic-playwright-${process.pid}.sock`);
    fs.rmSync(this._socketPath, { force: true });
    this.proxy = new CdpProxy(this, this._socketPath, downloadsDir);
    this._ipcServer = http.createServer((_req, res) => res.writeHead(404).end());
    this._ipcServer.on('upgrade', (req, socket, head) => {
      if (!this.proxy.handleUpgrade(req, socket, head))
        socket.destroy();
    });
    await new Promise<void>(resolve => this._ipcServer!.listen(this._socketPath, resolve));
    fs.chmodSync(this._socketPath, 0o600);
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
    this._attached = true;
    this._sweeper = setInterval(() => void this._sweep(), 15_000);
    this._sweeper.unref();
    const restored = [...this.sessions.values()].filter(s => s.targets.size);
    console.error(`[${this.options.profile}] gateway on ${this.baseUrl}/mcp, browser ${this.options.cdpEndpoint}, ` +
      `tab groups ${this.groups ? 'on' : 'off'}${restored.length ? `; restored ${restored.length} session(s) with their tabs` : ''}`);
  }

  // keepBrowser: leave the browser and every session's tabs as they are, for
  // the next gateway to pick up (a service restart). Otherwise close them.
  async stop({ keepBrowser = false } = {}) {
    this._stopping = true;
    clearInterval(this._sweeper);
    clearInterval(this._homeTimer);
    for (const { transport } of this._transports.values())
      await transport.close().catch(() => {});
    if (keepBrowser) {
      this._saveState();
    } else {
      for (const session of this.sessions.values())
        await this._closeSession(session);
    }
    this.proxy?.closeAll();
    this._server?.close();
    this._ipcServer?.close();
    fs.rmSync(this._socketPath, { force: true });
    // Only disconnects; the supervisor closes the browser.
    this.shared?.dispose();
  }

  // Connects to the browser and sets everything up on it. Runs at startup
  // and again after the connection drops.
  private async _attach(saved?: SavedSession[]) {
    let shared: SharedBrowser;
    shared = await SharedBrowser.connect(this.options.cdpEndpoint, this.owners, {
      onOwnedTarget: (owner, targetId) => this._onOwnedTarget(owner, targetId),
      onTargetDestroyed: targetId => this._onTargetDestroyed(targetId),
      onTargetChanged: () => {},
      onPageCall: (targetId, call) => this._onPageCall(targetId, call),
      isOwnerAlive: owner => !!this.sessions.get(owner) && !this.sessions.get(owner)!.disposed,
      onDownloadEvent: message => void this.proxy.onDownloadEvent(message).catch(() => {}),
      onDisconnected: () => this._onDisconnected(shared),
      // Nobody hears a browser they cannot see: tabs are muted while it is
      // hidden or minimized (pages do not notice).
      onVisibilityChanged: visible => void this.groups?.setMuted(!visible).catch(e => console.error(`sound: ${(e as Error).message}`)),
    }, [popupInterceptScript, permissionScript, passkeyScript], connecting => this._attaching = connecting);
    this.shared = shared;
    await shared.setDownloadBehavior(this.proxy.downloadsDir);
    const groups = new TabGroups(shared);
    this.groups = await groups.init() ? groups : undefined;
    for (const decision of this._permissions)
      await shared.setPermission(decision).catch(() => {});
    await this._setUpTabs(saved);
    this._dockAppliedAt = 0;
    await this._applyDockTile();
  }

  // A tab became a session's (it opened it, its page opened it, a fork copy).
  private _onOwnedTarget(owner: string, targetId: string) {
    const session = this.sessions.get(owner);
    if (session)
      void this.groups?.addTarget(session, targetId).catch(() => {});
    this.proxy.onOwnedTarget(owner, targetId);
    this.onTabsChanged();
  }

  // A page script asks the gateway (see browser.ts bridgeScript).
  private async _onPageCall(targetId: string, call: PageCall): Promise<unknown> {
    switch (call.kind) {
      case 'open': {
        const owner = this.sessions.get(this.owners.get(targetId) ?? '');
        await owner?.openInBackground(String(call.payload ?? ''), targetId);
        return null;
      }
      case 'permission':
        return await this._onPermissionRequest(targetId, call.url, call.payload);
      case 'passkey':
        return await this._onPasskeyRequest(targetId, call.url, call.payload);
    }
    return null;
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
        // Its SharedBrowser, if it got that far: canary socket, focus guard.
        if (this.shared?.cdp === connection)
          this.shared.dispose();
        connection.close();
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
    if (this._stopping || shared !== this.shared || this._abandoned.has(shared.cdp))
      return;
    console.error('browser connection lost; reconnecting');
    // Whether the browser dropped every DevTools client or only ours.
    setTimeout(() => console.error(`the gateway's second DevTools connection is ${shared.canaryState()}`), 1000).unref();
    this._connection++;
    this.proxy.closeAll();
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
        const tabs = this.owners.size;
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
    const pages = new Map(this.shared.pages().map(info => [info.targetId, info]));
    for (const entry of saved ?? []) {
      if (!entry.targets.some(id => pages.has(id)))
        continue;
      if (entry.info.pid !== undefined && !isAlive(entry.info.pid))
        continue;
      // The chat may have reconnected already, while the gateway was starting.
      let session = this.sessions.get(entry.info.id);
      if (session?.started)
        continue;
      if (!session) {
        session = new AgentSession(entry.info, this, this._config, this._retentionDays);
        this.sessions.set(entry.info.id, session);
      } else {
        // It connected before its saved state was loaded: its title is still
        // the client's fallback until the chat's own title is read again.
        session.info.title = entry.info.title;
      }
      session.filesDir = entry.filesDir;
      session.startedAt = entry.startedAt;
      for (const id of entry.targets) {
        if (pages.has(id))
          this.owners.set(id, entry.info.id);
      }
      session.currentTarget = entry.current;
      session.lastActivity = entry.lastActivity;
      session.restoreSavedState(entry.network);
    }
    // Tabs that closed while the gateway was away.
    for (const [targetId, owner] of [...this.owners]) {
      if (!pages.has(targetId) || !this.sessions.has(owner))
        this.owners.delete(targetId);
    }
    // The home tab is never a chat's tab (a chat's page may well be at the
    // gateway's address): the status page, else any tab no chat owns.
    const unowned = [...pages.values()].filter(info => !this.owners.has(info.targetId));
    const homeId = unowned.find(info => info.url.startsWith(this.baseUrl))?.targetId ?? unowned[0]?.targetId
      // With --no-startup-window there may be no window yet.
      ?? await this.shared.createTarget({ url: this.statusUrl, newWindow: true });
    for (const info of unowned) {
      if (info.targetId !== homeId)
        await this.shared.closeTarget(info.targetId);
    }
    await this._adoptHome(homeId);
    this._saveState();
  }

  private async _adoptHome(homeId: string) {
    this._homeTargetId = homeId;
    this.shared.setHomeTarget(homeId);
    if (this.shared.info(homeId)?.url !== this.statusUrl)
      await this.shared.navigate(homeId, this.statusUrl).catch(() => {});
    this._renderHome();
    clearInterval(this._homeTimer);
    this._homeTimer = setInterval(() => this._renderHome(), 5000);
    this._homeTimer.unref();
    await this.groups?.pin(homeId).catch(() => {});
    await this.shared.startFocusGuard(homeId);
    await this.shared.hideApp();
  }

  // A tab really closed (not just a dropped connection).
  private _onTargetDestroyed(targetId: string) {
    if (this.owners.delete(targetId))
      this.onTabsChanged();
    // Closing the window (red button) closes every tab in it; put a fresh,
    // hidden window back so agents have somewhere to open tabs.
    if (targetId === this._homeTargetId && !this._stopping) {
      console.error('browser window was closed; creating a new hidden one');
      this._homeTargetId = undefined;
      const shared = this.shared;
      void shared.createTarget({ url: this.statusUrl, newWindow: true }).then(async id => {
        if (shared === this.shared)
          await this._adoptHome(id);
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
      this._renderHome();
    }, 1000);
    this._saveTimer.unref();
  }

  // Set once the gateway has taken over the browser's tabs. Before that the
  // sessions are not loaded yet: saving would wipe the saved ones, and the
  // next start would close every chat's tabs as orphans.
  private _attached = false;

  private _saveState() {
    const file = this.options.stateFile;
    if (!file || !this._attached)
      return;
    const sessions: SavedSession[] = [...this.sessions.values()].filter(s => s.targets.size).map(s => ({
      info: s.info,
      filesDir: s.filesDir,
      lastActivity: s.lastActivity,
      startedAt: s.startedAt,
      targets: [...s.targets],
      current: s.currentTarget,
      network: s.savedState(),
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
  private async _onPermissionRequest(targetId: string, frameUrl: string, raw: any) {
    const owner = this.sessions.get(this.owners.get(targetId) ?? '');
    const permissions = Array.isArray(raw?.permissions) ? raw.permissions.filter((p: unknown) => typeof p === 'string' && p in permissionTypes) : [];
    if (!owner || !permissions.length)
      return;
    const origin = safeOrigin(this.shared.info(targetId)?.url ?? '') || safeOrigin(frameUrl);
    const frameOrigin = safeOrigin(frameUrl) || origin;
    const decided = (name: string) => this._permissions.find(d => d.type === permissionTypes[name][0] && d.origin === origin && d.embeddedOrigin === frameOrigin)?.setting;
    // Decided before: the browser answers by itself.
    if (permissions.every((name: string) => decided(name) === 'granted'))
      return;
    const refusedBefore = permissions.some((name: string) => decided(name) === 'denied');
    const hold = !!raw.hold && !refusedBefore;
    const request: PermissionRequest = {
      targetId,
      tab: targetId.slice(0, 8),
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
    const current = original.currentTarget;
    const copies: { targetId: string; current: boolean }[] = [];
    const failed: string[] = [];
    for (const targetId of original.targets) {
      try {
        // Owned by the fork before the copy may run, so the original chat
        // never takes it for a popup of its tab. A browser started before the
        // extension could duplicate tabs keeps the old extension until it
        // restarts: open the same URL then.
        const copy = this.groups
          ? await this.shared.claimCreation(this.groups.duplicate(targetId), session.info.id).catch(() => this._copyByUrl(targetId, session))
          : await this._copyByUrl(targetId, session);
        copies.push({ targetId: copy, current: targetId === current });
        await this.groups?.addTarget(session, copy).catch(() => {});
      } catch (e) {
        failed.push(`${targetId.slice(0, 8)} (${(e as Error).message})`);
      }
    }
    session.currentTarget = copies.find(c => c.current)?.targetId ?? copies[0]?.targetId;
    console.error(`fork ${session.info.title}: copied ${copies.length} tab(s) of ${original.info.title}${failed.length ? `, failed: ${failed.join(', ')}` : ''}`);
    const ids = copies.map(c => c.targetId.slice(0, 8) + (c.current ? ' (current)' : ''));
    return `### Tabs of the original chat\nThis chat is a fork of "${original.info.title}". Its tabs were copied into your ` +
      `group: ${ids.join(', ') || 'none'}${failed.length ? `; could not copy ${failed.join(', ')}` : ''}. The original tabs stay ` +
      'with that chat. The copies are fresh loads of the same pages (history kept): what a page held only in memory is ' +
      'gone, and pages that act when loaded (payments, one-time links, form results) may repeat that or show an error. ' +
      'Take a snapshot before acting.';
  }

  // Without the extension's "Duplicate": open the same URL (no history or
  // sessionStorage).
  private async _copyByUrl(targetId: string, session: AgentSession): Promise<string> {
    const info = this.shared.info(targetId);
    if (!info)
      throw new Error('tab not found');
    return await this.shared.createTarget({ url: info.url, owner: session.info.id });
  }

  private _desktopChatFile(desktopChat: string) {
    let file = this._desktopChats.get(desktopChat);
    if (!file)
      this._desktopChats.set(desktopChat, file = new DesktopChatFile(desktopChat));
    return file;
  }

  // A page asks for a passkey (see passkeys.ts): 'cancel' when nobody can see
  // the browser to answer the prompt, else 'proceed'.
  private async _onPasskeyRequest(targetId: string, frameUrl: string, raw: any): Promise<'cancel' | 'proceed'> {
    const owner = this.sessions.get(this.owners.get(targetId) ?? '');
    const kind = raw?.kind === 'create' ? 'create' : 'get';
    const visible = await this.shared.userCanSee(targetId).catch(() => false);
    const pageOrigin = safeOrigin(this.shared.info(targetId)?.url ?? '');
    const request: PasskeyRequest = {
      targetId,
      tab: targetId.slice(0, 8),
      origin: pageOrigin || safeOrigin(frameUrl),
      frameOrigin: safeOrigin(frameUrl) || pageOrigin,
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
  async answerPermissions(session: AgentSession, decision: 'allow' | 'deny', names: string[] | undefined, origin: string | undefined, currentUrl: string | undefined) {
    const unknown = (names ?? []).filter(name => !(name in permissionTypes));
    if (unknown.length)
      throw new Error(`Unknown permission ${unknown.join(', ')}. Known: ${Object.keys(permissionTypes).join(', ')}`);
    const matching = session.permissionRequests.filter(r => r.status === 'pending' || r.status === 'refused' || r.status === 'timed out')
        .filter(r => (!names || r.permissions.some(p => names.includes(p))) && (!origin || r.origin === origin || r.frameOrigin === origin));
    const targets = matching.map(r => ({ origin: r.origin, frameOrigin: r.frameOrigin, permissions: names ? r.permissions.filter(p => names.includes(p)) : r.permissions }));
    if (!targets.length) {
      const pageOrigin = origin ?? safeOrigin(currentUrl ?? '');
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
    // Only this machine's own clients. Any web page can send requests here,
    // and with DNS rebinding a site's own name resolves to this address, which
    // makes the gateway "same origin" with it; browser_run_code_unsafe runs
    // code in this process. Browsers send that name as Host, and an Origin
    // header with requests pages make; MCP clients send neither.
    if (!this._isLocalRequest(req) || (url.pathname === '/mcp' && req.headers.origin !== undefined)) {
      console.error(`refused a request for ${url.pathname} (host ${req.headers.host ?? '-'}, origin ${req.headers.origin ?? '-'})`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Only local MCP clients may use this address.');
      return;
    }
    if (url.pathname === '/mcp')
      return await this._handleMcp(req, res);
    if (url.pathname === '/focus') {
      await this._ready;
      return await this._handleFocus(url, res);
    }
    if (url.pathname === '/' && req.method === 'GET') {
      // A note only (answered 200: it also tells that the gateway is up).
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>${escapeHtml(this.options.profile)} · agentic-playwright-mcp</title><p>The status page is shown in the agent browser's pinned tab.</p>`);
      return;
    }
    res.writeHead(404).end('Not found');
  }

  private _isLocalRequest(req: http.IncomingMessage) {
    const port = this.options.port;
    const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${this.options.host ?? '127.0.0.1'}:${port}`];
    return localHosts.includes(String(req.headers.host ?? '').toLowerCase());
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
    session = new AgentSession(info, this, this._config, this._retentionDays);
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
        return await this._openTabWindow(target, String(args.targetId ?? ''));
      }
      await this._keepDownloadFolder();
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
        await untilAborted(this._ready, signal);
        result = await session.callTool(name, args, signal);
      } catch (e) {
        if (generation === this._connection)
          throw e;
      }
      // The session's own connection may notice a drop before the gateway's.
      if (result?.cutOff && generation === this._connection)
        await this._droppedOrNot(generation);
      if (generation === this._connection && !result?.cutOff)
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

  // A session's connection closed during a call: give the gateway's own
  // connection a moment to tell whether the browser dropped them all.
  private async _droppedOrNot(generation: number) {
    for (let i = 0; i < 40 && generation === this._connection; i++)
      await new Promise(r => setTimeout(r, 50));
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
      sub = new AgentSession(info, this, this._config, this._retentionDays);
      this.sessions.set(id, sub);
    }
    return sub;
  }

  private async _tabLink(session: AgentSession, index: unknown) {
    // From the session's Playwright; while its thread sleeps, the current tab
    // it remembered.
    const remembered = index === undefined && session.currentTarget && session.targets.has(session.currentTarget)
      ? this.shared.info(session.currentTarget) : undefined;
    const tab = await session.tab(index === undefined ? undefined : Number(index))
      ?? (remembered && { targetId: remembered.targetId, url: remembered.url, title: remembered.title });
    if (!tab)
      return errorResult('No such tab. Open a page first (browser_navigate), then call this again.');
    const { targetId, url, title } = tab;
    const link = `${this.baseUrl}/focus?target=${targetId}&t=${linkToken(this._linkSecret, `target:${targetId}`)}`;
    // Claude Code shows the model structuredContent instead of the text, so the
    // link and what to do with it are in both.
    const instruction = `Give the user this link as a markdown link, e.g. [Open "${title || url}" in the agent browser](${link}). ` +
      'Clicking it brings the agent browser window to the front on this tab.';
    return {
      content: [{ type: 'text' as const, text: instruction }],
      structuredContent: { link, instruction, targetId, url, title, profile: this.options.profile },
    };
  }

  // SessionHost: a chat's browser_tabs also lists its subagents' tabs.
  subagentTabs(session: AgentSession): string | undefined {
    if (session.info.id.includes('#'))
      return undefined;
    const lines: string[] = [];
    for (const child of this.sessions.values()) {
      const targets = child.info.id.startsWith(`${session.info.id}#`) ? child.targets : new Set<string>();
      if (!targets.size)
        continue;
      lines.push(`- ${child.info.label ?? child.info.id.split('#')[1]}:`);
      for (const targetId of targets)
        lines.push(`  - ${this.shared.info(targetId)?.url ?? '(closed)'}`);
    }
    return lines.length ? `### Your subagents' tabs\n${lines.join('\n')}` : undefined;
  }

  // Only tabs of the calling chat (or its subagents) can be brought forward.
  private async _openTabWindow(session: AgentSession, targetId: string) {
    const root = session.info.id.split('#')[0];
    const ours = [...this.sessions.values()].some(s => s.info.id.split('#')[0] === root &&
        [...s.targets].some(id => id === targetId));
    if (!targetId || !ours || !this.shared.info(targetId))
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
    this.sessions.set(info.id, new AgentSession(info, this, this._config, this._retentionDays));
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
    // Tab links raise the browser window, so only signed links act: a web
    // page (in an agent's tab or anywhere) cannot make one, the user can
    // click one from anywhere (see linktoken.ts).
    const signed = url.searchParams.get('home') ? 'home' : `target:${url.searchParams.get('target') ?? ''}`;
    if (url.searchParams.get('t') !== linkToken(this._linkSecret, signed)) {
      console.error('focus request refused: the link is not signed');
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('This link is not valid. Ask the agent for a new tab link.');
      return;
    }
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
        if (!icon || !this.groups)
          return;
        this._dockImage = await renderDockIcon(this.shared, icon, badge, badgeColor ?? '#d93025');
      }
      await this.shared.setDockTile(this._dockImage);
      this._dockAppliedAt = Date.now();
    } catch (e) {
      console.error(`dock icon: ${(e as Error).message}`);
    }
  }

  // Chrome goes back to its default download folder whenever another
  // DevTools client that set its own disconnects (a script, a viewer), and
  // tells nobody: set the gateway's again before each call and now and then.
  private async _keepDownloadFolder() {
    await this.shared?.setDownloadBehavior(this.proxy.downloadsDir).catch(() => {});
  }

  private async _sweep() {
    const now = Date.now();
    await this._keepDownloadFolder();
    if (now - this._dockAppliedAt > 60 * 1000)
      await this._applyDockTile();
    this._refreshTitles();
    if (now - this._filesSweptAt > 60 * 60 * 1000) {
      this._filesSweptAt = now;
      const inUse = new Set([...this.sessions.values()].map(s => s.filesDir).filter((dir): dir is string => !!dir));
      for (const name of cleanFolders(this.options.filesDir, this._retentionDays * 24 * 60 * 60 * 1000, inUse))
        console.error(`files: deleted ${name} (unused for ${this._retentionDays} days)`);
      if (this.options.browserDownloadsDir) {
        for (const name of cleanOldEntries(this.options.browserDownloadsDir, this._retentionDays * 24 * 60 * 60 * 1000))
          console.error(`browser downloads: deleted ${name} (unused for ${this._retentionDays} days)`);
      }
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
    for (const [targetId, owner] of [...this.owners]) {
      if (owner === session.info.id)
        this.owners.delete(targetId);
    }
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

function logUnhandledRejection(reason: unknown) {
  console.error('unhandled rejection (ignored):', reason);
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
