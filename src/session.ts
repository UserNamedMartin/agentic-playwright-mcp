// One agent session = one MCP connection = one Playwright MCP BrowserBackend
// sharing the profile's browser context. The stock Context adopts every page in
// the browser context and opens tabs in the foreground; here each session only
// sees the tabs it opened (plus popups those tabs open), and opens them in the
// background.
import fs from 'node:fs';
import type { Page } from 'playwright-core';
import type { SharedBrowser } from './browser.js';
import type { TabGroups } from './groups.js';
import { touchFolder } from './files.js';
import { pwTools, verifyContext } from './internals.js';

export type SessionInfo = {
  id: string;
  title: string;
  pid?: number;
  cwd?: string;
  claudeSessionId?: string;
  configDir?: string;
};

export class AgentSession {
  readonly info: SessionInfo;
  readonly owned = new Set<Page>();
  backend: any;
  lastActivity = Date.now();
  subagentCount = 0;
  private _shared: SharedBrowser;
  private _groups: TabGroups | undefined;
  private _config: any;
  private _tools: any[];
  // Everything this session saves goes here (see files.ts).
  readonly filesDir: string;
  private _filesNoted = false;
  private _touchedAt = 0;
  private _retentionDays: number;

  constructor(info: SessionInfo, shared: SharedBrowser, config: any, tools: any[], filesDir: string, groups?: TabGroups, retentionDays = 7) {
    this.info = info;
    this.filesDir = filesDir;
    this._retentionDays = retentionDays;
    this._shared = shared;
    this._config = config;
    this._tools = tools;
    this._groups = groups;
  }

  async start() {
    fs.mkdirSync(this.filesDir, { recursive: true });
    // The session folder is both the output dir and the workspace, so relative
    // file names land there too, never in the agent's project. Unrestricted
    // access lets the agent still upload project files by absolute path.
    const config = { ...this._config, outputDir: this.filesDir, allowUnrestrictedFileAccess: true };
    const backend = new pwTools.BrowserBackend(config, this._shared.context, this._tools, {});
    await backend.initialize({ cwd: this.filesDir, clientName: this.info.title });
    verifyContext(backend._context);
    this._patchContext(backend._context);
    this.backend = backend;
  }

  // Calls of one session run one at a time: parallel subagents share this
  // session, and the stock Context has a single "current tab".
  async callTool(name: string, args: any, signal?: AbortSignal) {
    const run = this._queue.then(() => this._callTool(name, args, signal));
    this._queue = run.catch(() => {});
    return await run;
  }

  private _queue: Promise<unknown> = Promise.resolve();

  private async _callTool(name: string, rawArgs: any, signal?: AbortSignal) {
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
      touchFolder(this.filesDir);
      this._touchedAt = Date.now();
    }
    const result = await this.backend.callTool(name, args, signal);
    // Tell the agent once where its files go; paths in later results are
    // relative to this folder.
    if (!this._filesNoted && !result.isError) {
      this._filesNoted = true;
      result.content.push({ type: 'text', text: `### Files\nFiles this browser session saves (screenshots, snapshots, downloads, videos, ` +
        `traces, relative file names) go to ${this.filesDir}; paths in results are relative to it. The folder is deleted after ` +
        `${this._retentionDays} days without use: copy anything worth keeping into the project.` });
    }
    // browser_close disposes the backend; the next call gets a fresh one.
    if (this.backend._disposed)
      this.backend = undefined;
    else if (name === 'browser_tabs' && !result.isError)
      result.content.push({ type: 'text', text: await this._tabIds() });
    return result;
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
  async openInBackground(url: string) {
    if (!this.backend)
      await this.start();
    const context = this.backend._context;
    await context.ensureBrowserContext();
    const page = await this._shared.newBackgroundPage(url);
    this._adopt(context, page);
    await this._groups?.addPage(this, page).catch(() => {});
  }

  currentPage(): Page | undefined {
    return this.backend?._context?.currentTab()?.page;
  }

  async dispose({ closeTabs }: { closeTabs: boolean }) {
    const backend = this.backend;
    this.backend = undefined;
    if (closeTabs) {
      for (const page of [...this.owned])
        await page.close().catch(() => {});
    }
    await backend?.dispose().catch(() => {});
  }

  private _adopt(context: any, page: Page) {
    this.owned.add(page);
    page.once('close', () => this.owned.delete(page));
    if (!context._tabs.some((tab: any) => tab.page === page))
      context._onPageCreated(page);
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
      session._adopt(this, page);
      await session._groups?.addPage(session, page).catch(() => {});
      this._currentTab = this._tabs.find((tab: any) => tab.page === page);
      return this._currentTab;
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
