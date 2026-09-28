// Every agent session's Playwright connects to the shared browser through its
// own DevTools endpoint here, and sees a browser that holds only its own tabs.
// Isolation lives in this one place, at the protocol level: Playwright MCP runs
// unchanged in each session, and everything it scopes to "the browser
// context" (pages, events, routes, init scripts, tracing, the recorder, video,
// offline mode, timeouts) is naturally that session's, because its connection
// only ever attaches to the session's tabs. The protocol commands that reach
// the whole browser are few and listed below; any other browser-level command
// is refused, so nothing new slips through with a Playwright upgrade.
//
// Each session gets a real connection of its own to the browser (Chrome keeps
// sessions of different connections apart: bindings, scripts, interception);
// the proxy decides which targets it attaches to and filters the messages that
// are not tied to one of them. It is the same idea as Playwright's own relay
// for its browser extension (tools/mcp/cdpRelay).
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { CdpConnection, type CdpMessage } from './cdp.js';
import type { SharedBrowser } from './browser.js';
import { ScreenshotDiagnostics } from './screenshot-diagnostics.js';
import { wsServer } from './internals.js';
import { internalUrl, internalUrlResolved } from './urls.js';

export type ProxyHost = {
  readonly shared: SharedBrowser;
  // Ports agents may not reach (see urls.ts).
  internalPorts(): string[];
  // A session's tab was sent to an internal address and taken back.
  onNavigationBlocked(key: string, url: string, reason: string): void;
};

const refusedMessage = (method: string) => `${method} is not available: it reaches the whole browser, which other chats share.`;

// Commands on a tab's own session that still reach the whole browser: every
// site's cookies and storage, the browser's cache, downloads and service
// workers, other targets.
const sessionRefused = new RegExp('^(' + [
  'Network\\.(getAllCookies|clearBrowserCookies|clearBrowserCache)',
  'Storage\\.\\w+',
  'Page\\.setDownloadBehavior',
  'Security\\.setIgnoreCertificateErrors',
  '(SystemInfo|Tethering|Browser|ServiceWorker|PWA|Extensions|Tracing|BackgroundService|CacheStorage|IndexedDB|DeviceAccess|FedCm)\\.\\w+',
].join('|') + ')$');

// The Target commands a tab's session may use: its own children (frames,
// workers) and itself. Anything else there reaches other tabs.
const sessionTargetCommands = new Set(['Target.setAutoAttach', 'Target.detachFromTarget', 'Target.getTargetInfo']);

export class CdpProxy {
  private _host: ProxyHost;
  private _clients = new Map<string, ProxyClient>();
  private _bySecret = new Map<string, ProxyClient>();
  private _wss = new wsServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
  // Download guid -> session key, and where the browser saves downloads.
  private _downloads = new Map<string, string>();
  readonly downloadsDir: string;
  // Downloads of tabs no session owns (started in the window by hand): guid
  // -> file name; they go to this folder when they finish.
  private _strays = new Map<string, string>();
  private _strayDownloadsDir: string | undefined;
  private _socketPath: string;

  // Sessions connect over a local socket file, not a TCP port: no page (and
  // no request an agent's code makes, see netguard.ts) can reach it, and each
  // session's connection lives inside its agent's network guard.
  constructor(host: ProxyHost, socketPath: string, downloadsDir: string, strayDownloadsDir?: string) {
    this._host = host;
    this._socketPath = socketPath;
    this.downloadsDir = downloadsDir;
    this._strayDownloadsDir = strayDownloadsDir;
  }

  get shared() {
    return this._host.shared;
  }

  // The DevTools endpoint of a session: an unguessable path on the socket.
  endpoint(key: string): string {
    return `ws+unix://${this._socketPath}:/cdp/${this.client(key).secret}`;
  }

  client(key: string): ProxyClient {
    let client = this._clients.get(key);
    if (!client) {
      client = new ProxyClient(this, this._host, key);
      this._clients.set(key, client);
      this._bySecret.set(client.secret, client);
    }
    return client;
  }

  // The session ended: its connection closes; its tabs are the gateway's to close.
  forget(key: string) {
    const client = this._clients.get(key);
    if (!client)
      return;
    client.close();
    this._clients.delete(key);
    this._bySecret.delete(client.secret);
  }

  // The browser connection dropped (all of the browser's DevTools clients go
  // together): every session's Playwright is disconnected and reconnects on
  // its next call.
  closeAll() {
    for (const client of this._clients.values())
      client.close();
  }

  // An upgrade request on the gateway's port; true if it was ours.
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const match = (req.url ?? '').match(/^\/cdp\/([0-9a-f]{32})$/);
    if (!match)
      return false;
    const client = this._bySecret.get(match[1]);
    // No page may connect (browsers send Origin with WebSocket requests).
    if (!client || req.headers.origin !== undefined) {
      socket.destroy();
      return true;
    }
    this._wss.handleUpgrade(req, socket, head, (ws: any) => void client.accept(ws).catch(e => {
      console.error(`proxy: ${client.key}: ${(e as Error).message}`);
      ws.close();
    }));
    return true;
  }

  // SharedBrowser: a new tab of `owner`.
  onOwnedTarget(owner: string, targetId: string) {
    const client = this._clients.get(owner);
    if (!client?.offer(targetId))
      void this.shared.release(targetId);
  }

  // SharedBrowser: download events go to the session whose tab downloads.
  onDownloadEvent(message: CdpMessage) {
    const { method, params } = message;
    if (method === 'Browser.downloadWillBegin') {
      const tab = this.shared.takeDownloadTab(params.guid);
      const owner = tab ? this.shared.owners.get(tab) : undefined;
      if (!owner) {
        this._strays.set(params.guid, String(params.suggestedFilename ?? ''));
        return;
      }
      this._downloads.set(params.guid, owner);
      this._clients.get(owner)?.onDownloadEvent(message);
      return;
    }
    const owner = this._downloads.get(params.guid);
    if (!owner) {
      if (this._strays.has(params.guid) && params.state !== 'inProgress')
        this._settleStray(params.guid, params.state);
      return;
    }
    if (params.state !== 'inProgress')
      this._downloads.delete(params.guid);
    this._clients.get(owner)?.onDownloadEvent(message);
  }

  // The gateway's folder is emptied at every start: a finished download of
  // nobody's tab goes where the browser keeps its own downloads.
  private _settleStray(guid: string, state: string) {
    const suggested = path.basename(this._strays.get(guid) ?? '');
    const name = suggested && suggested !== '.' && suggested !== '..' ? suggested : guid;
    this._strays.delete(guid);
    const from = path.join(this.downloadsDir, guid);
    try {
      if (state !== 'completed' || !this._strayDownloadsDir) {
        if (state !== 'completed')
          fs.rmSync(from, { force: true });
        return;
      }
      fs.mkdirSync(this._strayDownloadsDir, { recursive: true });
      const ext = path.extname(name);
      let to = path.join(this._strayDownloadsDir, name);
      for (let i = 1; fs.existsSync(to); i++)
        to = path.join(this._strayDownloadsDir, `${path.basename(name, ext)} (${i})${ext}`);
      moveFile(from, to);
    } catch (e) {
      console.error(`download ${guid}: ${(e as Error).message}`);
    }
  }

  downloadOwner(guid: string) {
    return this._downloads.get(guid);
  }

  // Whether the session's Playwright closed its connection itself (its code
  // closed the browser context), rather than the browser dropping it.
  closedByClient(key: string) {
    return !!this._clients.get(key)?.closedByClient;
  }
}

// One session's view of the browser.
class ProxyClient {
  readonly key: string;
  readonly secret = crypto.randomBytes(16).toString('hex');
  private _proxy: CdpProxy;
  private _host: ProxyHost;
  private _ws: any;
  private _real: CdpConnection | undefined;
  // Real session id -> target id, for the tabs this client is attached to.
  private _sessions = new Map<string, string>();
  private _attached = new Map<string, string>(); // target id -> session id
  private _attaching = new Set<string>();
  private _autoAttach = false;
  // Browser sessions made by newBrowserCDPSession(): browser-level rules.
  private _browserSessions = new Set<string>();
  // Answers to messages sent on such a session carry its id; so do the
  // events of sessions attached through it.
  private _replyTag = new Map<number, string>();
  private _parentSession = new Map<string, string>();
  private _downloadPath: string | undefined;
  private _denyDownloads = false;
  closedByClient = false;
  // Page.getFrameTree calls on a fresh link tab (see _onSessionMessage).
  private _freshTreeCalls = new Set<number>();
  private _screenshots: ScreenshotDiagnostics;

  constructor(proxy: CdpProxy, host: ProxyHost, key: string) {
    this._proxy = proxy;
    this._host = host;
    this.key = key;
    const diagnosticSession = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
    this._screenshots = new ScreenshotDiagnostics({ session: diagnosticSession, log: line => console.error(line) });
  }

  private get _shared() {
    return this._proxy.shared;
  }

  private _owns(targetId: unknown) {
    return typeof targetId === 'string' && this._shared.owners.get(targetId) === this.key;
  }

  // A cookie sent to one of the pages open in this session's tabs (the rule
  // Playwright's context.cookies(urls) uses).
  private _ownSite(cookie: { domain: string; path: string; secure: boolean }) {
    for (const info of this._shared.pages()) {
      if (!this._owns(info.targetId) || !/^https?:/.test(info.url))
        continue;
      const url = new URL(info.url);
      const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
      if (!`.${url.hostname}`.endsWith(domain) || !url.pathname.startsWith(cookie.path))
        continue;
      if (cookie.secure && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        continue;
      return true;
    }
    return false;
  }

  // A Playwright connection for this session. There is one at a time: a new
  // one replaces the old (a reconnecting session).
  async accept(ws: any) {
    this.close();
    this._ws = ws;
    this.closedByClient = false;
    const queue: CdpMessage[] = [];
    let ready = false;
    ws.on('message', (data: Buffer) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!ready)
        queue.push(message);
      else
        void this._onClientMessage(message).catch(e => this._fail(message, (e as Error).message));
    });
    ws.on('close', () => {
      if (this._ws !== ws)
        return;
      this.closedByClient = true;
      this.close();
    });
    const real = await CdpConnection.connect(this._shared.browserUrl);
    if (this._ws !== ws) {
      real.close();
      return;
    }
    this._real = real;
    real.onMessage = message => this._onBrowserMessage(message);
    real.onClose = () => {
      if (this._real === real)
        this.close();
    };
    ready = true;
    for (const message of queue.splice(0))
      void this._onClientMessage(message).catch(e => this._fail(message, (e as Error).message));
  }

  close() {
    this._screenshots.close();
    const ws = this._ws;
    const real = this._real;
    this._ws = undefined;
    this._real = undefined;
    this._sessions.clear();
    this._attached.clear();
    this._attaching.clear();
    this._browserSessions.clear();
    this._replyTag.clear();
    this._parentSession.clear();
    this._autoAttach = false;
    ws?.close();
    real?.close();
  }

  private _send(message: CdpMessage) {
    if (this._ws?.readyState === 1)
      this._ws.send(JSON.stringify(message));
  }

  private _reply(message: CdpMessage, result: any) {
    const sessionId = message.sessionId ?? this._replyTag.get(message.id!);
    this._replyTag.delete(message.id!);
    this._send({ id: message.id, result, ...(sessionId ? { sessionId } : {}) });
  }

  private _fail(message: CdpMessage, text: string) {
    if (process.env.APM_PROXY_DEBUG)
      console.error(`proxy ${this.key}: refused ${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 120)}: ${text.slice(0, 80)}`);
    const sessionId = message.sessionId ?? this._replyTag.get(message.id!);
    this._replyTag.delete(message.id!);
    this._send({ id: message.id, error: { code: -32000, message: text }, ...(sessionId ? { sessionId } : {}) });
  }

  // A tab of ours appeared (new, or found after reconnecting): attach to it
  // and tell Playwright, which sets it up and lets it run. False when no
  // Playwright is listening (the tab then runs at once).
  offer(targetId: string): boolean {
    if (!this._real || !this._autoAttach)
      return false;
    void this._attach(targetId).catch(() => void this._shared.release(targetId));
    return true;
  }

  private async _attach(targetId: string) {
    if (this._attached.has(targetId) || this._attaching.has(targetId) || !this._real)
      return;
    this._attaching.add(targetId);
    try {
      const real = this._real;
      const { sessionId } = await real.send('Target.attachToTarget', { targetId, flatten: true });
      if (real !== this._real)
        return;
      this._sessions.set(sessionId, targetId);
      this._attached.set(targetId, sessionId);
      const info = this._shared.info(targetId);
      const opener = this._shared.openers.get(targetId) ?? info?.openerId;
      const waiting = this._shared.isHeld(targetId);
      this._send({ method: 'Target.attachedToTarget', params: {
        sessionId,
        targetInfo: {
          targetId, type: info?.type ?? 'page', title: info?.title ?? '', url: info?.url ?? 'about:blank', attached: true,
          canAccessOpener: false, browserContextId: info?.browserContextId,
          ...(opener && this._owns(opener) ? { openerId: opener } : {}),
        },
        waitingForDebugger: waiting,
      } });
    } finally {
      this._attaching.delete(targetId);
    }
  }

  private _onBrowserMessage(message: CdpMessage) {
    if (message.id !== undefined) {
      if (message.sessionId)
        this._screenshots.finish(message.sessionId, message.id, message.error);
      // An answer to a message we passed through as it was.
      if (this._freshTreeCalls.delete(message.id) && message.result?.frameTree?.frame)
        message.result.frameTree.frame.url = '';
      this._send(message);
      return;
    }
    if (!message.sessionId) {
      // Browser-level events: only the detach of our own sessions.
      if (message.method === 'Target.detachedFromTarget' && this._sessions.has(message.params?.sessionId)) {
        const sessionId = message.params.sessionId;
        const targetId = this._sessions.get(sessionId)!;
        this._sessions.delete(sessionId);
        // (A CDP session of the tab ending is not the tab's own session.)
        if (this._attached.get(targetId) === sessionId)
          this._attached.delete(targetId);
        const parent = this._parentSession.get(sessionId);
        this._parentSession.delete(sessionId);
        this._send(parent ? { ...message, sessionId: parent } : message);
      }
      return;
    }
    if (message.method === 'Page.frameNavigated')
      void this._checkNavigation(message).catch(() => {});
    this._send(message);
  }

  // A frame of ours that lands on an internal address (a redirect, a page's
  // own script, a name that resolves to this machine) is sent to about:blank
  // at once.
  private async _checkNavigation(message: CdpMessage) {
    const frame = message.params?.frame;
    if (typeof frame?.url !== 'string')
      return;
    const reason = await internalUrlResolved(frame.url, this._host.internalPorts());
    if (!reason)
      return;
    console.error(`${this.key}: left ${frame.url} (${reason})`);
    this._host.onNavigationBlocked(this.key, frame.url, reason);
    await this._real?.send('Page.navigate', { url: 'about:blank', frameId: frame.id }, message.sessionId);
  }

  onDownloadEvent(message: CdpMessage) {
    const { method, params } = message;
    if (method === 'Browser.downloadWillBegin' && this._denyDownloads) {
      void this._shared.cdp.send('Browser.cancelDownload', { guid: params.guid }).catch(() => {});
      return;
    }
    if (method === 'Browser.downloadProgress' && params.state === 'completed' && this._downloadPath) {
      try {
        fs.mkdirSync(this._downloadPath, { recursive: true });
        moveFile(path.join(this._proxy.downloadsDir, params.guid), path.join(this._downloadPath, params.guid));
      } catch (e) {
        console.error(`download ${params.guid}: ${(e as Error).message}`);
      }
    }
    this._send(message);
  }

  private async _onClientMessage(message: CdpMessage) {
    if (!this._real)
      return this._fail(message, 'The browser connection is closed.');
    const tag = message.sessionId && this._browserSessions.has(message.sessionId) ? message.sessionId : undefined;
    if (tag) {
      this._replyTag.set(message.id!, tag);
      return await this._onBrowserLevel({ ...message, sessionId: undefined });
    }
    if (!message.sessionId)
      return await this._onBrowserLevel(message);
    return await this._onSessionMessage(message);
  }

  // A command on one of our tabs (or frames, workers) passes through, except
  // the few that reach further.
  private async _onSessionMessage(message: CdpMessage) {
    const method = message.method ?? '';
    const params = message.params ?? {};
    if (method === 'Page.bringToFront')
      return this._reply(message, {});
    if (sessionRefused.test(method) || method.startsWith('Target.') && !sessionTargetCommands.has(method))
      return this._fail(message, refusedMessage(method));
    if (method === 'Target.getTargetInfo' && params.targetId !== undefined && !this._owns(params.targetId))
      return this._fail(message, 'No target with given id found');
    if (method === 'Page.navigate') {
      const reason = internalUrl(String(params.url ?? ''), this._host.internalPorts());
      if (reason)
        return this._fail(message, `${params.url} is not available to agents: ${reason}.`);
    }
    // A link tab (see popups.ts) opens blank and goes to its link once it
    // runs. Chrome's own popups have no document yet at this point, and
    // Playwright then reports them once the link has committed, not at
    // about:blank; its first look at the frame tree says so here too.
    if (method === 'Page.getFrameTree' && this._shared.isFreshLinkTab(this._sessions.get(message.sessionId!) ?? ''))
      this._freshTreeCalls.add(message.id!);
    if (method === 'Runtime.runIfWaitingForDebugger') {
      const targetId = this._sessions.get(message.sessionId!);
      this._real!.sendRaw(message);
      if (targetId)
        await this._shared.release(targetId);
      return;
    }
    if (method === 'Page.captureScreenshot')
      this._screenshots.start(message.sessionId!, message.id!, this._sessions.get(message.sessionId!), this._shared.visibilityForDiagnostics());
    this._real!.sendRaw(message);
  }

  private async _pass(message: CdpMessage) {
    try {
      this._reply(message, await this._real!.send(message.method!, message.params ?? {}));
    } catch (e) {
      this._fail(message, (e as Error).message.replace(/^[\w.]+: /, ''));
    }
  }

  private async _onBrowserLevel(message: CdpMessage) {
    const method = message.method ?? '';
    const params = message.params ?? {};
    switch (method) {
      case 'Storage.getCookies':
        // Cookies are the browser's (shared logins); a session sees those of
        // the sites open in its tabs, as the cookie tools do.
        try {
          const { cookies } = await this._real!.send('Storage.getCookies', params);
          return this._reply(message, { cookies: cookies.filter((c: any) => this._ownSite(c)) });
        } catch (e) {
          return this._fail(message, (e as Error).message);
        }
      case 'Storage.clearCookies':
        // "Clear all cookies" clears those of the session's sites.
        try {
          const { cookies } = await this._real!.send('Storage.getCookies', params);
          const own = cookies.filter((c: any) => this._ownSite(c));
          if (own.length)
            await this._real!.send('Storage.setCookies', { cookies: own.map((c: any) => ({ name: c.name, value: '', domain: c.domain, path: c.path, expires: 1 })) });
          return this._reply(message, {});
        } catch (e) {
          return this._fail(message, (e as Error).message);
        }
      case 'Browser.grantPermissions':
        // Permissions are per site and shared; "for every site" means the
        // sites of this session's tabs.
        if (params.origin)
          return await this._pass(message);
        try {
          const origins = new Set(this._shared.pages().filter(info => this._owns(info.targetId) && /^https?:/.test(info.url)).map(info => new URL(info.url).origin));
          for (const origin of origins)
            await this._real!.send(method, { ...params, origin });
          return this._reply(message, {});
        } catch (e) {
          return this._fail(message, (e as Error).message);
        }
      case 'Browser.getVersion':
      case 'Storage.setCookies':
      case 'Browser.setPermission':
      case 'Browser.getWindowBounds':
        return await this._pass(message);
      case 'Target.getTargetInfo':
        if (params.targetId !== undefined && !this._owns(params.targetId))
          return this._fail(message, 'No target with given id found');
        return await this._pass(message);
      case 'Target.closeTarget':
      case 'Browser.getWindowForTarget':
        if (!this._owns(params.targetId))
          return this._fail(message, 'No target with given id found');
        return await this._pass(message);
      case 'Target.attachToTarget': {
        // A CDP session on one of our tabs (newCDPSession).
        if (!this._owns(params.targetId))
          return this._fail(message, 'No target with given id found');
        try {
          const result = await this._real!.send(method, params);
          this._sessions.set(result.sessionId, params.targetId);
          const parent = this._replyTag.get(message.id!);
          if (parent)
            this._parentSession.set(result.sessionId, parent);
          return this._reply(message, result);
        } catch (e) {
          return this._fail(message, (e as Error).message);
        }
      }
      case 'Target.detachFromTarget':
        if (this._browserSessions.delete(params.sessionId))
          return this._reply(message, {});
        if (!this._sessions.has(params.sessionId))
          return this._fail(message, 'No session with given id');
        return await this._pass(message);
      case 'Target.attachToBrowserTarget': {
        const sessionId = `browser-${crypto.randomBytes(8).toString('hex')}`;
        this._browserSessions.add(sessionId);
        return this._reply(message, { sessionId });
      }
      case 'Target.setAutoAttach': {
        // Our existing tabs are announced before the answer, as Chrome does.
        this._autoAttach = !!params.autoAttach;
        if (this._autoAttach) {
          for (const [targetId, owner] of this._shared.owners) {
            if (owner === this.key && this._shared.info(targetId)?.type === 'page')
              await this._attach(targetId).catch(() => {});
          }
        }
        return this._reply(message, {});
      }
      case 'Target.createTarget': {
        const reason = internalUrl(String(params.url ?? ''), this._host.internalPorts());
        if (reason)
          return this._fail(message, `${params.url} is not available to agents: ${reason}.`);
        try {
          const targetId = await this._shared.createTarget({ url: params.url ?? 'about:blank', owner: this.key });
          // Playwright expects the tab to be attached before the answer.
          for (let i = 0; i < 250 && !this._attached.has(targetId) && this._real; i++)
            await new Promise(r => setTimeout(r, 20));
          return this._reply(message, { targetId });
        } catch (e) {
          return this._fail(message, (e as Error).message);
        }
      }
      case 'Target.getTargets': {
        const targetInfos = this._shared.pages().filter(info => this._owns(info.targetId))
            .map(info => ({ ...info, attached: this._attached.has(info.targetId), canAccessOpener: false }));
        return this._reply(message, { targetInfos });
      }
      case 'Target.setDiscoverTargets':
      case 'Target.activateTarget':
      case 'Browser.setWindowBounds':
        // Shared window, shared focus: nothing to do for one session.
        return this._reply(message, {});
      case 'Browser.setDownloadBehavior':
        // The browser saves every download to the gateway's folder; each is
        // moved to where this session's Playwright looks when it finishes.
        this._downloadPath = params.downloadPath;
        this._denyDownloads = params.behavior === 'deny';
        return this._reply(message, {});
      case 'Browser.cancelDownload':
        if (this._proxy.downloadOwner(params.guid) !== this.key)
          return this._fail(message, 'No download with given id');
        return await this._pass(message);
      default:
        return this._fail(message, refusedMessage(method));
    }
  }
}

function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV')
      throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}
