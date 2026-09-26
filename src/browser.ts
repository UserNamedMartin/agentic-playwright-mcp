// One real browser shared by every agent session of a profile. We talk to it
// over CDP: Playwright for everything page-level, a raw browser CDP session for
// the few browser-level calls Playwright does not expose (background tabs,
// window state, activation).
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { playwright, ws } from './internals.js';
import { activatePid, frontmostPid, hidePid, isHiddenPid, mainScreen, unhidePid } from './macos.js';

export class SharedBrowser {
  readonly browser: Browser;
  readonly context: BrowserContext;
  private _cdp: CDPSession;
  private _targetIds = new WeakMap<Page, string>();
  private _seen = new Map<string, Page>();
  private _waiters = new Map<string, (page: Page) => void>();
  // Tabs this gateway created for some session, and creations still in flight.
  // Tabs the gateway opened itself, until they close.
  _created = new Set<string>();
  private _inFlight = new Set<Promise<unknown>>();
  private _pid: number | undefined;
  private _userFocusAt = 0;
  private _otherFrontmost: number | undefined;
  private _homeTargetId: string | undefined;
  private _lastHidden = false;
  private _headless: boolean | undefined;
  private _guarding = false;
  private _guardTimer: NodeJS.Timeout | undefined;
  private _disposed = false;
  private _canary: any;
  private _canaryClosed: string | undefined;

  private constructor(browser: Browser, context: BrowserContext, cdp: CDPSession) {
    this.browser = browser;
    this.context = context;
    this._cdp = cdp;
    context.on('page', page => void this._onPage(page));
  }

  // onConnected hears of the connection as soon as it exists, so a caller
  // that gives up on a stalled setup can close it.
  static async connect(cdpEndpoint: string, onTargetDestroyed?: (targetId: string) => void,
    onConnected?: (browser: Browser) => void): Promise<SharedBrowser> {
    const browser: Browser = await playwright.chromium.connectOverCDP(cdpEndpoint, { timeout: 15_000 });
    onConnected?.(browser);
    const context = browser.contexts()[0];
    if (!context)
      throw new Error(`No default browser context at ${cdpEndpoint}`);
    const cdp = await browser.newBrowserCDPSession();
    const shared = new SharedBrowser(browser, context, cdp);
    // Tabs that really close. Pages also emit "close" when the connection
    // drops, which must not cost a session its tabs.
    cdp.on('Target.targetDestroyed', ({ targetId }) => {
      shared._created.delete(targetId);
      shared._popups.delete(targetId);
      onTargetDestroyed?.(targetId);
    });
    // Popups, with the tab that opened them, as Chrome reports them.
    cdp.on('Target.targetCreated', ({ targetInfo }: any) => {
      if (targetInfo.type === 'page' && targetInfo.openerId)
        shared._popups.set(targetInfo.targetId, { url: targetInfo.url, openerId: targetInfo.openerId, at: Date.now() });
    });
    cdp.on('Target.targetInfoChanged', ({ targetInfo }: any) => {
      const known = shared._popups.get(targetInfo.targetId);
      if (known)
        known.url = targetInfo.url;
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await shared._openCanary(cdpEndpoint).catch(() => {});
    return shared;
  }

  // Recently opened popups by target id.
  _popups = new Map<string, { url: string; openerId: string; at: number }>();

  // The tab that opened a popup whose first request is being held: that
  // request comes before Playwright knows the popup's page, and holding it
  // until then would keep the page from ever being made. Chrome reports a
  // popup (with its opener) at once and its URL only once it has loaded, so
  // popups that have not navigated yet, made in the last few seconds, are
  // the candidates. When they come from different tabs (two chats opening
  // popups at the same moment) nobody is told (undefined): no chat's routes
  // then apply, rather than the wrong chat's.
  async popupOpener(): Promise<string | undefined> {
    // Tabs the gateway opens itself are no popups, whatever opener Chrome
    // reports for them (a headed Chrome gives them the active tab): wait for
    // those being made to be known.
    if (this._inFlight.size)
      await Promise.all([...this._inFlight].map(creation => creation.catch(() => {})));
    for (let waited = 0; waited <= 500; waited += 25) {
      const now = Date.now();
      const openers = new Set<string>();
      for (const [id, popup] of this._popups) {
        if (now - popup.at > 10_000 || this._created.has(id))
          this._popups.delete(id);
        else if ((!popup.url || popup.url === 'about:blank') && now - popup.at < 3000)
          openers.add(popup.openerId);
      }
      if (openers.size === 1)
        return [...openers][0];
      if (openers.size > 1)
        return undefined;
      await new Promise(r => setTimeout(r, 25));
    }
    return undefined;
  }

  // A second, idle DevTools connection. When the main one drops, its state
  // tells whether the browser closed every client or only ours.
  private async _openCanary(cdpEndpoint: string) {
    const res = await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(5000) });
    const { webSocketDebuggerUrl } = await res.json() as { webSocketDebuggerUrl: string };
    const socket = new ws(webSocketDebuggerUrl);
    socket.on('close', (code: number, reason: Buffer) => this._canaryClosed = `closed with code ${code}${reason.length ? ` (${reason})` : ''}`);
    socket.on('error', () => {});
    this._canary = socket;
  }

  canaryState() {
    return this._canaryClosed ?? 'still open';
  }

  // The connection is gone: stop timers so a replacement can take over.
  dispose() {
    this._disposed = true;
    clearInterval(this._guardTimer);
    this._canary?.close();
  }

  // The target id of a page seen before, without asking the browser (works
  // after a disconnect too).
  cachedTargetId(page: Page): string | undefined {
    return this._targetIds.get(page);
  }

  async targetId(page: Page): Promise<string> {
    let id = this._targetIds.get(page);
    if (id)
      return id;
    const session = await this.context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      id = targetInfo.targetId;
    } finally {
      await session.detach().catch(() => {});
    }
    this._targetIds.set(page, id);
    return id;
  }

  async pageByTargetId(targetId: string): Promise<Page | undefined> {
    for (const page of this.context.pages()) {
      if (await this.targetId(page).catch(() => undefined) === targetId)
        return page;
    }
    return undefined;
  }

  private async _onPage(page: Page) {
    const id = await this.targetId(page).catch(() => undefined);
    if (!id)
      return;
    const waiter = this._waiters.get(id);
    if (waiter) {
      this._waiters.delete(id);
      waiter(page);
      return;
    }
    // The page event can arrive before Target.createTarget returns.
    this._seen.set(id, page);
    setTimeout(() => this._seen.delete(id), 30_000).unref();
  }

  // Opens a tab without activating it, so a minimized window stays minimized
  // and focus stays wherever the user is. Playwright's context.newPage() opens
  // tabs in the foreground, which un-minimizes the window.
  async newBackgroundPage(url = 'about:blank', newWindow = false): Promise<Page> {
    return await this.createdPage(this._cdp.send('Target.createTarget', { url, background: true, focus: false, ...(newWindow ? { newWindow: true, windowState: 'minimized' } : {}) } as any)
        .then(({ targetId }) => targetId));
  }

  // The page of a tab the gateway is creating (resolves to its target id).
  // Marked as the gateway's own, so no session takes it for a popup of the tab
  // it came from.
  async createdPage(creation: Promise<string>): Promise<Page> {
    this._inFlight.add(creation);
    const targetId = await creation.finally(() => this._inFlight.delete(creation));
    this._created.add(targetId);
    const seen = this._seen.get(targetId);
    if (seen) {
      this._seen.delete(targetId);
      return seen;
    }
    return await new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(targetId);
        reject(new Error(`Timed out waiting for tab ${targetId}`));
      }, 30_000);
      this._waiters.set(targetId, page => {
        clearTimeout(timer);
        resolve(page);
      });
    });
  }

  // In a headed browser Chrome records the active tab as the opener of a tab
  // created over CDP, so "has an opener" does not mean "is a popup". A page is
  // a popup only if the gateway did not create it.
  async isGatewayCreated(page: Page): Promise<boolean> {
    await Promise.allSettled([...this._inFlight]);
    return this._created.has(await this.targetId(page));
  }

  async windowIdFor(targetId: string): Promise<number> {
    const { windowId } = await this._cdp.send('Browser.getWindowForTarget', { targetId });
    return windowId;
  }

  async setWindowState(targetId: string, windowState: 'normal' | 'minimized' | 'maximized') {
    const windowId = await this.windowIdFor(targetId);
    await this._cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
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
    await this._cdp.send('Target.activateTarget', { targetId });
    const page = await this.pageByTargetId(targetId);
    if (page) {
      const session = await this.context.newCDPSession(page);
      await session.send('Page.bringToFront').finally(() => session.detach().catch(() => {}));
    }
    await this.activateApp();
    setTimeout(() => console.error(`focus: front is now pid ${frontmostPid()} (browser ${this._pid})`), 500).unref();
  }

  // Show the window on the main display, wherever it was left.
  private async _moveToMainScreen(targetId: string) {
    const screen = mainScreen();
    if (!screen)
      return;
    const windowId = await this.windowIdFor(targetId);
    const { bounds } = await this._cdp.send('Browser.getWindowBounds', { windowId });
    const centerX = (bounds.left ?? 0) + (bounds.width ?? 0) / 2;
    const centerY = (bounds.top ?? 0) + (bounds.height ?? 0) / 2;
    if (centerX >= screen.left && centerX < screen.left + screen.width && centerY >= screen.top && centerY < screen.top + screen.height)
      return;
    const width = Math.min(bounds.width ?? 1200, screen.width);
    const height = Math.min(bounds.height ?? 900, screen.height);
    await this._cdp.send('Browser.setWindowBounds', { windowId, bounds: {
      left: Math.round(screen.left + (screen.width - width) / 2),
      top: Math.round(screen.top + (screen.height - height) / 2),
      width, height,
    } });
  }

  async pid(): Promise<number | undefined> {
    if (this._pid)
      return this._pid;
    const info: any = await this._cdp.send('SystemInfo.getProcessInfo' as any).catch(() => undefined);
    this._pid = info?.processInfo?.find((p: any) => p.type === 'browser')?.id;
    return this._pid;
  }

  async isHeadless() {
    if (this._headless === undefined) {
      // New headless (Chrome 132+) reports a normal product name, but keeps
      // "HeadlessChrome" in the user agent.
      const { product, userAgent } = await this._cdp.send('Browser.getVersion');
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
    if (process.platform !== 'darwin' || await this.isHeadless())
      return;
    const pid = await this.pid();
    const sample = async () => {
      if (this._guarding || !pid || this._disposed)
        return;
      const front = frontmostPid();
      if (front && front !== pid)
        this._otherFrontmost = front;
      this._lastHidden = isHiddenPid(pid);
      const state = await this._windowState().catch(() => undefined);
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
    // Browser-level target events arrive sooner than Playwright's page event.
    this._cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type === 'page')
        void this._guardFocus();
    });
  }

  // Whether someone could be looking at this tab's window: the browser is
  // headed, not hidden, and the window is not minimized. Pages cannot tell by
  // themselves (document.visibilityState stays "visible" in the hidden browser).
  async userCanSee(page: Page): Promise<boolean> {
    if (await this.isHeadless())
      return false;
    const pid = await this.pid();
    if (pid && process.platform === 'darwin' && isHiddenPid(pid))
      return false;
    const windowId = await this.windowIdFor(await this.targetId(page));
    const { bounds } = await this._cdp.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState !== 'minimized';
  }

  async setPermission({ type, setting, origin, embeddedOrigin }: { type: string; setting: 'granted' | 'denied'; origin: string; embeddedOrigin: string }) {
    await this._cdp.send('Browser.setPermission', { permission: { name: type }, setting, origin, embeddedOrigin } as any);
  }

  async setDockTile(image: string) {
    await this._cdp.send('Browser.setDockTile' as any, { image });
  }

  setHomeTarget(targetId: string) {
    this._homeTargetId = targetId;
  }

  private async _windowState() {
    const windowId = await this.windowIdFor(this._homeTargetId!);
    const { bounds } = await this._cdp.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState;
  }

  private async _guardFocus() {
    if (!this._homeTargetId || this._guarding || Date.now() - this._userFocusAt < 10_000)
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

  async close() {
    await this.browser.close().catch(() => {});
  }
}

