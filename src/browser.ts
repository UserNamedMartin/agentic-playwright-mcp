// One real browser shared by every agent session of a profile. The gateway
// sees all of it through one raw DevTools connection (not Playwright: the
// agents' Playwright connections attach to the same pages, see proxy.ts, and
// two Playwrights on one page answer each other's page bindings). Here:
// - every tab (target) and who owns it; a new tab is held (waiting for the
//   debugger) until its owner's Playwright has set it up, so routes and init
//   scripts reach its first load, as they would with one Playwright;
// - the gateway's own page scripts (background tabs for links, permission and
//   passkey requests), talking back through one raw binding;
// - browser-level work: background tabs, window state, activation, focus
//   guard, permissions, the Dock icon, the companion extension.
import { CdpConnection, type CdpMessage } from './cdp.js';
import { activatePid, frontmostPid, hidePid, isHiddenPid, mainScreen, unhidePid } from './macos.js';

export type TargetInfo = {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
  browserContextId?: string;
};

// What a page script sends through the bridge (see bridgeScript).
export type PageCall = { kind: string; payload: any; url: string };

export type BrowserEvents = {
  // A new tab whose owner is known: the owner's Playwright should take it over
  // and call release() once it has (the tab waits until then).
  onOwnedTarget(owner: string, targetId: string): void;
  onTargetDestroyed(targetId: string): void;
  onTargetChanged(targetId: string): void;
  onPageCall(targetId: string, call: PageCall): Promise<unknown>;
  // Whether a session still exists (a tab created for one that has ended
  // meanwhile is closed, not left behind unowned).
  isOwnerAlive(owner: string): boolean;
  // Browser.downloadWillBegin / downloadProgress.
  onDownloadEvent(message: CdpMessage): void;
  onDisconnected(): void;
  // Whether someone could be looking at the browser now (see isVisible).
  onVisibilityChanged(visible: boolean): void;
};

// The binding page scripts reach the gateway through, and the object they use.
// The binding is taken off the page's global object right away; only the
// bridge (non-enumerable, frozen) stays.
const bindingName = '__agenticGatewayBinding';
export const bridgeScript = `(() => {
  if (window.__agenticBridge)
    return;
  const send = globalThis[${JSON.stringify(bindingName)}];
  if (typeof send !== 'function')
    return;
  try { delete globalThis[${JSON.stringify(bindingName)}]; } catch {}
  const pending = new Map();
  let seq = 0;
  Object.defineProperty(window, '__agenticBridge', { value: Object.freeze({
    call: (kind, payload) => new Promise(resolve => {
      const id = ++seq;
      pending.set(id, resolve);
      send(JSON.stringify({ id, kind, payload, url: location.href }));
    }),
    reply: (id, value) => {
      const resolve = pending.get(id);
      pending.delete(id);
      if (resolve)
        resolve(value);
    },
  }) });
})();`;

// Longest a new tab waits for its owner's Playwright before it runs anyway.
const holdMs = 10_000;
// Longest an attach decision waits for tab creations under way.
const creationWaitMs = 2_000;

type Entry = { info: TargetInfo; session?: string; waiting: boolean; holdTimer?: NodeJS.Timeout };

export class SharedBrowser {
  readonly cdp: CdpConnection;
  // Owner (session key) by target id; owned by the gateway, so it outlives a
  // dropped connection.
  readonly owners: Map<string, string>;
  private _events: BrowserEvents;
  private _scripts: string[];
  private _targets = new Map<string, Entry>();
  // Master session id -> the page target it belongs to (pages and their
  // out-of-process frames).
  private _sessionPage = new Map<string, string>();
  // Download guid -> the tab it started in (from Page.downloadWillBegin).
  private _downloadTabs = new Map<string, string>();
  // Tab creations under way (their owner is set when they resolve).
  private _creations = new Set<Promise<unknown>>();
  // Tabs the gateway opened for a page (a link): the page they came from,
  // told to the owner's Playwright as their opener.
  readonly openers = new Map<string, string>();
  private _extensionSession: string | undefined;
  private _pid: number | undefined;
  private _headless: boolean | undefined;
  private _userFocusAt = 0;
  private _otherFrontmost: number | undefined;
  private _homeTargetId: string | undefined;
  private _lastHidden = false;
  private _guarding = false;
  private _guardTimer: NodeJS.Timeout | undefined;
  private _disposed = false;
  private _canary: any;
  private _canaryClosed: string | undefined;

  private constructor(cdp: CdpConnection, owners: Map<string, string>, events: BrowserEvents, scripts: string[]) {
    this.cdp = cdp;
    this.owners = owners;
    this._events = events;
    this._scripts = [bridgeScript, ...scripts];
  }

  // onConnected hears of the connection as soon as it exists, so a caller
  // that gives up on a stalled setup can close it.
  static async connect(cdpEndpoint: string, owners: Map<string, string>, events: BrowserEvents, scripts: string[],
    onConnected?: (cdp: CdpConnection) => void): Promise<SharedBrowser> {
    const url = await CdpConnection.browserUrl(cdpEndpoint);
    const cdp = await CdpConnection.connect(url);
    onConnected?.(cdp);
    const shared = new SharedBrowser(cdp, owners, events, scripts);
    shared._browserUrl = url;
    cdp.onMessage = message => void shared._onMessage(message).catch(e => console.error(`browser event ${message.method}: ${(e as Error).message}`));
    cdp.onClose = () => {
      if (!shared._disposed)
        events.onDisconnected();
    };
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    // Existing tabs are attached before this answers; new ones wait for us.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await shared._openCanary(url).catch(() => {});
    return shared;
  }

  private _browserUrl = '';

  // The browser-level WebSocket address, for the proxy's own connections.
  get browserUrl() {
    return this._browserUrl;
  }

  // A second, idle DevTools connection. When the main one drops, its state
  // tells whether the browser closed every client or only ours.
  private async _openCanary(url: string) {
    const canary = await CdpConnection.connect(url, 5000);
    canary.onClose = () => this._canaryClosed = 'closed';
    this._canary = canary;
  }

  canaryState() {
    return this._canaryClosed ?? 'still open';
  }

  // The connection is gone (or given up): stop timers so a replacement can
  // take over.
  dispose() {
    this._disposed = true;
    clearInterval(this._guardTimer);
    for (const entry of this._targets.values())
      clearTimeout(entry.holdTimer);
    this._canary?.close();
    this.cdp.close();
  }

  // --- Targets

  pages(): TargetInfo[] {
    return [...this._targets.values()].filter(e => e.info.type === 'page').map(e => e.info);
  }

  info(targetId: string): TargetInfo | undefined {
    return this._targets.get(targetId)?.info;
  }

  isHeld(targetId: string) {
    return !!this._targets.get(targetId)?.waiting;
  }

  // Lets a held tab run (its owner has set it up, or nobody will).
  async release(targetId: string) {
    const entry = this._targets.get(targetId);
    if (!entry?.waiting)
      return;
    entry.waiting = false;
    clearTimeout(entry.holdTimer);
    await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, entry.session).catch(() => {});
    const navigation = this._pendingNavigations.get(targetId);
    this._pendingNavigations.delete(targetId);
    if (navigation)
      await this.cdp.send('Page.navigate', navigation, entry.session).catch(() => {});
  }

  // Tabs opened blank for a link, and where they go once they run (see
  // createTarget's navigateTo).
  private _pendingNavigations = new Map<string, { url: string; referrer?: string }>();

  // A link tab that has not gone to its link yet: its owner's Playwright
  // should see it as a tab with no document yet, as a popup is.
  isFreshLinkTab(targetId: string) {
    return this._pendingNavigations.has(targetId);
  }

  private async _onMessage(message: CdpMessage) {
    const { method, params, sessionId } = message;
    switch (method) {
      case 'Target.attachedToTarget':
        if (sessionId)
          await this._onChildAttached(sessionId, params);
        else
          await this._onAttached(params);
        return;
      case 'Target.detachedFromTarget':
        this._sessionPage.delete(params.sessionId);
        for (const entry of this._targets.values()) {
          if (entry.session === params.sessionId)
            entry.session = undefined;
        }
        if (params.sessionId === this._extensionSession)
          this._extensionSession = undefined;
        return;
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info: TargetInfo = params.targetInfo;
        const entry = this._targets.get(info.targetId);
        if (entry) {
          entry.info = { ...entry.info, ...pick(info) };
          this._events.onTargetChanged(info.targetId);
        } else if (method === 'Target.targetCreated') {
          this._targets.set(info.targetId, { info: pick(info), waiting: false });
        }
        if (method === 'Target.targetCreated' && info.type === 'page')
          void this._guardFocus();
        return;
      }
      case 'Target.targetDestroyed': {
        const entry = this._targets.get(params.targetId);
        clearTimeout(entry?.holdTimer);
        this._targets.delete(params.targetId);
        this.openers.delete(params.targetId);
        this._events.onTargetDestroyed(params.targetId);
        return;
      }
      case 'Runtime.bindingCalled':
        if (params.name === bindingName)
          await this._onBindingCalled(sessionId!, params);
        return;
      case 'Page.downloadWillBegin': {
        // Chrome sends this on the session of the page or out-of-process
        // frame that downloads, before the browser-wide event: which tab a
        // download belongs to comes from the protocol, never from a search.
        const tab = sessionId ? this._sessionPage.get(sessionId) : undefined;
        if (tab)
          this._downloadTabs.set(params.guid, tab);
        return;
      }
      case 'Browser.downloadWillBegin':
      case 'Browser.downloadProgress':
        this._events.onDownloadEvent(message);
        return;
    }
  }

  private async _onAttached(params: any) {
    const info: TargetInfo = pick(params.targetInfo);
    const entry: Entry = { info, session: params.sessionId, waiting: !!params.waitingForDebugger };
    const previous = this._targets.get(info.targetId);
    if (previous)
      clearTimeout(previous.holdTimer);
    this._targets.set(info.targetId, entry);
    if (info.type !== 'page') {
      await this.release(info.targetId);
      return;
    }
    this._sessionPage.set(params.sessionId, info.targetId);
    await this._installScripts(params.sessionId, params.targetInfo);
    // A tab being created (by an agent, a link, a fork) gets its owner when
    // the creation answers; a popup belongs to whoever owns its opener.
    await this._creationsSettled();
    let owner = this.owners.get(info.targetId);
    if (!owner && info.openerId) {
      owner = this.owners.get(info.openerId);
      if (owner)
        this.owners.set(info.targetId, owner);
    }
    if (!owner || !entry.waiting) {
      await this.release(info.targetId);
      if (owner)
        this._events.onOwnedTarget(owner, info.targetId);
      return;
    }
    entry.holdTimer = setTimeout(() => void this.release(info.targetId), holdMs);
    this._events.onOwnedTarget(owner, info.targetId);
  }

  // An out-of-process frame (or worker) of a page: the page scripts go into
  // frames too (a permission request often comes from an embedded site).
  private async _onChildAttached(parentSession: string, params: any) {
    const pageTarget = this._sessionPage.get(parentSession);
    if (params.targetInfo?.type === 'iframe' && pageTarget) {
      this._sessionPage.set(params.sessionId, pageTarget);
      await this._installScripts(params.sessionId, params.targetInfo);
    }
    await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
  }

  private async _installScripts(session: string, info: { type: string; targetId: string; url: string }) {
    // (The binding and the scripts need the Runtime and Page domains on.)
    await Promise.all([
      this.cdp.send('Page.enable', {}, session),
      this.cdp.send('Runtime.enable', {}, session),
      this.cdp.send('Runtime.addBinding', { name: bindingName }, session),
      ...this._scripts.map(source => this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, session)),
      this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session),
    ]).catch(e => console.error(`page scripts (${info.type} ${info.targetId.slice(0, 8)} ${info.url.slice(0, 120)}): ${(e as Error).message}`));
  }

  private async _onBindingCalled(session: string, params: any) {
    const targetId = this._sessionPage.get(session);
    let call: { id: number } & PageCall;
    try {
      call = JSON.parse(params.payload);
    } catch {
      return;
    }
    if (!targetId || typeof call?.kind !== 'string')
      return;
    const value = await this._events.onPageCall(targetId, { kind: call.kind, payload: call.payload, url: String(call.url ?? '') })
        .catch(e => ({ error: String((e as Error).message ?? e) }));
    await this.cdp.send('Runtime.evaluate', {
      expression: `window.__agenticBridge && window.__agenticBridge.reply(${Number(call.id)}, ${JSON.stringify(value ?? null)})`,
      contextId: params.executionContextId,
    }, session).catch(() => {});
  }

  private async _creationsSettled() {
    if (!this._creations.size)
      return;
    await Promise.race([
      Promise.allSettled([...this._creations]),
      new Promise(r => setTimeout(r, creationWaitMs)),
    ]);
  }

  // Opens a tab without activating it, so a minimized window stays minimized
  // and focus stays wherever the user is. `owner` gets it (else nobody);
  // `opener` is the page it was opened for (a link). A tab created with its
  // address starts loading before its owner's Playwright can attach routes or
  // offline mode, so `navigateTo` opens it blank and goes there once it runs.
  async createTarget({ url = 'about:blank', owner, opener, navigateTo, newWindow = false }:
    { url?: string; owner?: string; opener?: string; navigateTo?: string; newWindow?: boolean } = {}): Promise<string> {
    const creation = this.cdp.send<{ targetId: string }>('Target.createTarget', {
      url, background: true, focus: false, ...(newWindow ? { newWindow: true, windowState: 'minimized' } : {}),
    }).then(r => {
      if (navigateTo)
        this._pendingNavigations.set(r.targetId, { url: navigateTo, ...(opener ? { referrer: this.info(opener)?.url } : {}) });
      return r.targetId;
    });
    const targetId = await this.claimCreation(creation, owner, opener);
    // Nobody held it (no owner, or it was attached already): go now.
    if (navigateTo && !this.isHeld(targetId) && this._targets.get(targetId)?.session)
      await this.release(targetId).then(async () => {
        const navigation = this._pendingNavigations.get(targetId);
        this._pendingNavigations.delete(targetId);
        if (navigation)
          await this.cdp.send('Page.navigate', navigation, this._targets.get(targetId)?.session).catch(() => {});
      });
    return targetId;
  }

  // A tab something else is creating (the extension duplicating one): who
  // owns it is decided when it answers, before its tab may run.
  async claimCreation(creation: Promise<string>, owner?: string, opener?: string): Promise<string> {
    const tracked = creation.then(async targetId => {
      if (owner && !this._events.isOwnerAlive(owner)) {
        await this.closeTarget(targetId);
        throw new Error('This browser session has ended.');
      }
      if (owner)
        this.owners.set(targetId, owner);
      if (opener)
        this.openers.set(targetId, opener);
      return targetId;
    });
    this._creations.add(tracked);
    try {
      return await tracked;
    } finally {
      this._creations.delete(tracked);
    }
  }

  async closeTarget(targetId: string) {
    await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  // Shows html in a tab (the status page).
  async setContent(targetId: string, html: string) {
    const session = this._targets.get(targetId)?.session;
    if (session)
      await this.cdp.send('Page.setDocumentContent', { frameId: targetId, html }, session, 5000);
  }

  async navigate(targetId: string, url: string, referrer?: string) {
    const session = this._targets.get(targetId)?.session;
    if (session)
      await this.cdp.send('Page.navigate', { url, ...(referrer ? { referrer } : {}) }, session);
  }

  // The tab a download started in, told by the browser on that tab's (or its
  // out-of-process frame's) session just before Browser.downloadWillBegin.
  takeDownloadTab(guid: string): string | undefined {
    const tab = this._downloadTabs.get(guid);
    this._downloadTabs.delete(guid);
    return tab;
  }

  // --- The companion extension (tab groups, duplicating tabs)

  // Runs an expression in the extension's service worker.
  async extensionEvaluate<T>(expression: string): Promise<T> {
    const session = await this._extensionWorker();
    if (!session)
      throw new Error('The companion extension is not running');
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  }

  // The extension was reloaded: look for its new service worker.
  forgetExtension() {
    this._extensionSession = undefined;
  }

  private async _extensionWorker(): Promise<string | undefined> {
    if (this._extensionSession)
      return this._extensionSession;
    for (const entry of this._targets.values()) {
      if (entry.info.type !== 'service_worker' || !entry.info.url.startsWith('chrome-extension://') || !entry.session)
        continue;
      const { result } = await this.cdp.send('Runtime.evaluate', { expression: 'typeof self.apmPing === "function"', returnByValue: true }, entry.session, 5000)
          .catch(() => ({ result: { value: false } }));
      if (result.value) {
        this._extensionSession = entry.session;
        return entry.session;
      }
    }
    return undefined;
  }

  // --- Window, focus, app

  async windowIdFor(targetId: string): Promise<number> {
    const { windowId } = await this.cdp.send('Browser.getWindowForTarget', { targetId });
    return windowId;
  }

  async setWindowState(targetId: string, windowState: 'normal' | 'minimized' | 'maximized') {
    const windowId = await this.windowIdFor(targetId);
    await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  }

  // Brings the browser to the front on exactly this tab. Only ever called on an
  // explicit user request (a tab link), never as a side effect of agent work.
  // Activating another app from a background process is often ignored by
  // macOS (cooperative activation). Chrome raising itself (Page.bringToFront)
  // works only some of the time, so activation also goes through the link
  // applet (see macos.ts).
  async focusTab(targetId: string) {
    this._userFocusAt = Date.now();
    console.error(`focus: showing tab ${targetId.slice(0, 8)} (front was pid ${frontmostPid()})`);
    // A hidden app's window cannot be un-minimized, so unhide first.
    const pid = await this.pid();
    if (pid && process.platform === 'darwin')
      unhidePid(pid);
    await this.setWindowState(targetId, 'normal');
    await this._moveToMainScreen(targetId).catch(() => {});
    await this.cdp.send('Target.activateTarget', { targetId });
    const session = this._targets.get(targetId)?.session;
    if (session)
      await this.cdp.send('Page.bringToFront', {}, session).catch(() => {});
    await this.activateApp();
    setTimeout(() => console.error(`focus: front is now pid ${frontmostPid()} (browser ${this._pid})`), 500).unref();
  }

  // Show the window on the main display, wherever it was left.
  private async _moveToMainScreen(targetId: string) {
    const screen = mainScreen();
    if (!screen)
      return;
    const windowId = await this.windowIdFor(targetId);
    const { bounds } = await this.cdp.send('Browser.getWindowBounds', { windowId });
    const centerX = (bounds.left ?? 0) + (bounds.width ?? 0) / 2;
    const centerY = (bounds.top ?? 0) + (bounds.height ?? 0) / 2;
    if (centerX >= screen.left && centerX < screen.left + screen.width && centerY >= screen.top && centerY < screen.top + screen.height)
      return;
    const width = Math.min(bounds.width ?? 1200, screen.width);
    const height = Math.min(bounds.height ?? 900, screen.height);
    await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: {
      left: Math.round(screen.left + (screen.width - width) / 2),
      top: Math.round(screen.top + (screen.height - height) / 2),
      width, height,
    } });
  }

  async pid(): Promise<number | undefined> {
    if (this._pid)
      return this._pid;
    const info: any = await this.cdp.send('SystemInfo.getProcessInfo').catch(() => undefined);
    this._pid = info?.processInfo?.find((p: any) => p.type === 'browser')?.id;
    return this._pid;
  }

  async isHeadless() {
    if (this._headless === undefined) {
      // New headless (Chrome 132+) reports a normal product name, but keeps
      // "HeadlessChrome" in the user agent.
      const { product, userAgent } = await this.cdp.send('Browser.getVersion');
      this._headless = product.startsWith('HeadlessChrome') || userAgent.includes('HeadlessChrome');
    }
    return this._headless;
  }

  async activateApp() {
    if (await this.isHeadless())
      return;
    const pid = await this.pid();
    if (pid)
      activatePid(pid);
  }

  // Out of sight = window minimized AND app hidden (like Cmd+H). Hidden, its
  // minimized window leaves no thumbnail in the Dock; minimized, new tabs do
  // not bring the app back into view.
  async hideApp() {
    if (process.platform !== 'darwin' || await this.isHeadless())
      return;
    const pid = await this.pid();
    if (!pid)
      return;
    if (this._homeTargetId && await this._windowState().catch(() => undefined) !== 'minimized')
      await this.setWindowState(this._homeTargetId, 'minimized').catch(() => {});
    hidePid(pid);
    this._lastHidden = true;
  }

  // Keeps the browser out of the user's way:
  // - minimizing the window (yellow button) also hides the browser, so the
  //   minimized window never shows as a thumbnail in the Dock;
  // - pages can still raise the browser on their own (a window.open popup);
  //   after a new page appears the guard hides it again and gives focus back.
  // Explicit focusTab() requests are left alone.
  async startFocusGuard(homeTargetId: string) {
    this._homeTargetId = homeTargetId;
    this._visible = undefined;
    if (process.platform !== 'darwin' || await this.isHeadless()) {
      this._setVisible(!await this.isHeadless());
      return;
    }
    const pid = await this.pid();
    const sample = async () => {
      if (this._guarding || !pid || this._disposed)
        return;
      const front = frontmostPid();
      if (front && front !== pid)
        this._otherFrontmost = front;
      this._lastHidden = isHiddenPid(pid);
      const state = await this._windowState().catch(() => undefined);
      if (state)
        this._setVisible(!this._lastHidden && state !== 'minimized');
      if (!this._lastHidden && state === 'minimized') {
        console.error('window minimized; hiding the browser too');
        await this.hideApp();
      } else if (this._lastHidden && state && state !== 'minimized' && Date.now() - this._userFocusAt > 3000) {
        // Hidden with Cmd+H: minimize too, or the next new tab would show it.
        await this.setWindowState(this._homeTargetId!, 'minimized').catch(() => {});
      }
    };
    await sample();
    this._guardTimer = setInterval(() => void sample(), 500);
    this._guardTimer.unref();
  }

  private _visible: boolean | undefined;

  // Tells the gateway when the browser comes into view or goes out of it
  // (tabs are muted while nobody can see it).
  private _setVisible(visible: boolean) {
    if (visible === this._visible)
      return;
    this._visible = visible;
    this._events.onVisibilityChanged(visible);
  }

  // Whether someone could be looking at this tab's window: the browser is
  // headed, not hidden, and the window is not minimized. Pages cannot tell by
  // themselves (document.visibilityState stays "visible" in the hidden browser).
  async userCanSee(targetId: string): Promise<boolean> {
    if (await this.isHeadless())
      return false;
    const pid = await this.pid();
    if (pid && process.platform === 'darwin' && isHiddenPid(pid))
      return false;
    const windowId = await this.windowIdFor(targetId);
    const { bounds } = await this.cdp.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState !== 'minimized';
  }

  async setPermission({ type, setting, origin, embeddedOrigin }: { type: string; setting: 'granted' | 'denied'; origin: string; embeddedOrigin: string }) {
    await this.cdp.send('Browser.setPermission', { permission: { name: type }, setting, origin, embeddedOrigin });
  }

  async setDownloadBehavior(downloadPath: string) {
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
  }

  async setDockTile(image: string) {
    await this.cdp.send('Browser.setDockTile', { image });
  }

  setHomeTarget(targetId: string) {
    this._homeTargetId = targetId;
  }

  private async _windowState() {
    const windowId = await this.windowIdFor(this._homeTargetId!);
    const { bounds } = await this.cdp.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState;
  }

  private async _guardFocus() {
    if (!this._homeTargetId || this._guarding || Date.now() - this._userFocusAt < 10_000 || process.platform !== 'darwin')
      return;
    if (await this.isHeadless().catch(() => true))
      return;
    const pid = await this.pid();
    if (!pid)
      return;
    const wasHidden = this._lastHidden;
    const wasBehind = this._otherFrontmost !== undefined && frontmostPid() !== pid;
    this._guarding = true;
    try {
      for (let i = 0; i < 30 && !this._disposed; i++) {
        await new Promise(r => setTimeout(r, 100));
        // The user asked to see the window (tab link, browser_show_tab): stand down.
        if (Date.now() - this._userFocusAt < 10_000)
          break;
        const raised = frontmostPid() === pid;
        const shown = wasHidden && !isHiddenPid(pid);
        if (shown) {
          console.error('focus guard: a page showed the browser; hiding it again');
          await this.hideApp();
        } else if (raised && wasBehind && this._otherFrontmost) {
          console.error(`focus guard: a page took focus; giving it back to pid ${this._otherFrontmost}`);
          activatePid(this._otherFrontmost);
        }
      }
    } finally {
      this._guarding = false;
    }
  }

  // Closes the browser itself (not just our connection).
  async closeBrowser() {
    await this.cdp.send('Browser.close').catch(() => {});
  }
}

function pick(info: any): TargetInfo {
  return { targetId: info.targetId, type: info.type, url: info.url ?? '', title: info.title ?? '', openerId: info.openerId, browserContextId: info.browserContextId };
}
