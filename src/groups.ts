// Chrome tab groups per agent session, via the bundled companion extension.
// CDP has no tab-group API, so the gateway loads the extension over CDP
// (Extensions.loadUnpacked, which needs --enable-unsafe-extension-debugging)
// and calls functions in its service worker.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SharedBrowser } from './browser.js';
import type { AgentSession } from './session.js';

export const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const colors = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red', 'grey'];

export class TabGroups {
  private _shared: SharedBrowser;
  private _colors = new Map<string, string>();
  private _nextColor = 0;

  constructor(shared: SharedBrowser) {
    this._shared = shared;
  }

  async init(): Promise<boolean> {
    if (await this._ping())
      return true;
    try {
      await this._shared.cdp.send('Extensions.loadUnpacked', { path: extensionDir });
    } catch (e) {
      console.error(`Tab groups disabled: could not load the companion extension (${(e as Error).message}). ` +
        'The browser must be started with --enable-unsafe-extension-debugging.');
      return false;
    }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (await this._ping())
        return true;
    }
    return false;
  }

  private async _ping() {
    return await this._shared.extensionEvaluate<string>('self.apmPing()').then(r => r === 'ok', () => false);
  }

  private _call<T>(fn: string, ...args: unknown[]): Promise<T> {
    return this._shared.extensionEvaluate<T>(`self.${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`);
  }

  colorFor(session: AgentSession) {
    let color = this._colors.get(session.info.id);
    if (!color) {
      color = colors[this._nextColor++ % colors.length];
      this._colors.set(session.info.id, color);
    }
    return color;
  }

  async addTarget(session: AgentSession, targetId: string) {
    await this._call('apmAddToGroup', targetId, session.info.id, session.info.title, this.colorFor(session));
  }

  // Duplicates a tab (see apmDuplicateTarget); resolves to the new target id.
  async duplicate(targetId: string): Promise<string> {
    return await this._call<string>('apmDuplicateTarget', targetId);
  }

  async pin(targetId: string) {
    await this._call('apmPinTarget', targetId);
  }

  async rename(session: AgentSession) {
    await this._call('apmRenameGroup', session.info.id, session.info.title);
  }

  async forget(session: AgentSession) {
    this._colors.delete(session.info.id);
    await this._call('apmForgetGroup', session.info.id).catch(() => {});
  }
}
