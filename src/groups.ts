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
// self.apmVersion of the extension in extension/sw.js.
const extensionVersion = 3;

export class TabGroups {
  private _shared: SharedBrowser;
  private _colors = new Map<string, string>();
  private _nextColor = 0;

  constructor(shared: SharedBrowser) {
    this._shared = shared;
  }

  async init(): Promise<boolean> {
    if (await this._ping()) {
      if (await this._shared.extensionEvaluate<number>('self.apmVersion || 1').catch(() => 1) >= extensionVersion)
        return true;
      // An older copy of the extension still runs (the browser was started
      // before an update): loading it again reloads it from disk. Its stored
      // groups are gone then; a session's group is found again by its tabs.
      console.error('reloading the companion extension (an older version was running)');
      this._shared.forgetExtension();
    }
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
    const siblings = [...session.targets].filter(id => id !== targetId);
    await this._call('apmAddToGroup', targetId, session.info.id, session.info.title, this.colorFor(session), siblings);
  }

  // Duplicates a tab (see apmDuplicateTarget); resolves to the new target id.
  async duplicate(targetId: string): Promise<string> {
    return await this._call<string>('apmDuplicateTarget', targetId);
  }

  async pin(targetId: string) {
    await this._call('apmPinTarget', targetId);
  }

  // Puts a tab in front of its window without showing the window.
  async activate(targetId: string) {
    await this._call('apmActivateTarget', targetId);
  }

  // The tab in front of the window that holds this tab.
  async frontOf(targetId: string): Promise<string | null> {
    return await this._call<string | null>('apmFrontTarget', targetId);
  }

  async rename(session: AgentSession) {
    await this._call('apmRenameGroup', session.info.id, session.info.title);
  }

  // Mutes every tab for the user (pages do not notice), or unmutes the ones
  // the extension muted.
  async setMuted(muted: boolean) {
    await this._call('apmSetMuted', muted);
  }

  async forget(session: AgentSession) {
    this._colors.delete(session.info.id);
    await this._call('apmForgetGroup', session.info.id).catch(() => {});
  }
}
