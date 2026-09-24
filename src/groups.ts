// Chrome tab groups per agent session, via the bundled companion extension.
// CDP has no tab-group API, so the gateway loads the extension over CDP
// (Extensions.loadUnpacked, which needs --enable-unsafe-extension-debugging)
// and calls functions in its service worker.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Worker } from 'playwright-core';
import type { SharedBrowser } from './browser.js';
import type { AgentSession } from './session.js';

export const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const colors = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red', 'grey'];

export class TabGroups {
  private _shared: SharedBrowser;
  private _worker: Worker | undefined;
  private _colors = new Map<string, string>();
  private _nextColor = 0;

  constructor(shared: SharedBrowser) {
    this._shared = shared;
  }

  async init(): Promise<boolean> {
    if (await this._ensureWorker())
      return true;
    const cdp = await this._shared.browser.newBrowserCDPSession();
    try {
      await cdp.send('Extensions.loadUnpacked' as any, { path: extensionDir });
    } catch (e) {
      console.error(`Tab groups disabled: could not load the companion extension (${(e as Error).message}). ` +
        'The browser must be started with --enable-unsafe-extension-debugging.');
      return false;
    } finally {
      await cdp.detach().catch(() => {});
    }
    for (let i = 0; i < 20 && !this._worker; i++) {
      await new Promise(r => setTimeout(r, 250));
      await this._ensureWorker();
    }
    return !!this._worker;
  }

  colorFor(session: AgentSession) {
    let color = this._colors.get(session.info.id);
    if (!color) {
      color = colors[this._nextColor++ % colors.length];
      this._colors.set(session.info.id, color);
    }
    return color;
  }

  async addPage(session: AgentSession, page: Page) {
    const worker = await this._ensureWorker();
    if (!worker)
      return;
    const targetId = await this._shared.targetId(page);
    await worker.evaluate(([t, key, title, color]) => (self as any).apmAddToGroup(t, key, title, color),
        [targetId, session.info.id, session.info.title, this.colorFor(session)]);
  }

  async pin(page: Page) {
    const worker = await this._ensureWorker();
    const targetId = await this._shared.targetId(page);
    await worker?.evaluate(t => (self as any).apmPinTarget(t), targetId);
  }

  async rename(session: AgentSession) {
    const worker = await this._ensureWorker();
    await worker?.evaluate(([key, title]) => (self as any).apmRenameGroup(key, title), [session.info.id, session.info.title]);
  }

  async forget(session: AgentSession) {
    this._colors.delete(session.info.id);
    const worker = await this._ensureWorker();
    await worker?.evaluate(key => (self as any).apmForgetGroup(key), session.info.id).catch(() => {});
  }

  async extensionWorker() {
    return await this._ensureWorker();
  }

  // Finds our service worker among all extension workers by probing for the
  // function it defines. Playwright hands out a new Worker object whenever
  // Chrome restarts a suspended MV3 worker.
  private async _ensureWorker(): Promise<Worker | undefined> {
    const workers = this._shared.context.serviceWorkers();
    if (this._worker && workers.includes(this._worker))
      return this._worker;
    this._worker = undefined;
    for (const worker of workers) {
      if (!worker.url().startsWith('chrome-extension://'))
        continue;
      const ours = await worker.evaluate(() => typeof (self as any).apmPing === 'function').catch(() => false);
      if (ours) {
        this._worker = worker;
        break;
      }
    }
    return this._worker;
  }
}
