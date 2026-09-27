// One agent session's Playwright, in a worker thread of its own: its
// connection through the proxy (see proxy.ts), a stock Playwright MCP
// BrowserBackend and the session's tools. Code the agent runs
// (browser_run_code_unsafe) runs here, so a snippet stuck in a busy loop
// stops only this thread, which the gateway then ends and starts again; the
// session's tabs stay (the gateway owns them). See session.ts for the other
// side of the messages.
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { Browser, Page, Route } from 'playwright-core';
import { playwright, pwTools, verifyContext } from './internals.js';
import { agentCall, installNetGuard } from './netguard.js';
import { scopeTools } from './scoped.js';
import { applyEmulation, extraTools, type Emulation, type ToolHost } from './tools.js';

export type WorkerStart = {
  endpoint: string;
  config: any;
  filesDir: string;
  title: string;
  internalPorts: string[];
  routes: any[];
  offline: boolean;
  emulation: [string, Emulation][];
  currentTarget?: string;
};

// What a call's result tells the session besides the result itself.
export type CallOutcome = {
  result: any;
  // The connection closed during the call, and the backend with it.
  disconnected: boolean;
  disposed: boolean;
  currentTarget?: string;
  currentUrl?: string;
  tabIds?: string;
  routes: any[];
  codeRoutes: boolean;
  offline: boolean;
  emulation: [string, Emulation][];
};

export type ToWorker =
  | { type: 'call'; id: number; name: string; args: any; tab?: string }
  | { type: 'abandon'; id: number }
  | { type: 'ping'; n: number }
  | { type: 'tab'; id: number; index?: number }
  | { type: 'reply'; id: number; value?: any; error?: string };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | { type: 'result'; id: number; outcome?: CallOutcome; error?: string }
  | { type: 'pong'; n: number }
  | { type: 'tab'; id: number; tab?: { targetId: string; url: string; title: string } }
  | { type: 'rpc'; id: number; method: string; args: any[] };

// A call given up at its timeout keeps running; whatever it does, it no
// longer changes which tab is current (see patchContext).
const callState = new AsyncLocalStorage<{ abandoned: boolean }>();

const start = workerData as WorkerStart;
const port = parentPort!;
const send = (message: FromWorker) => port.postMessage(message);

// Everything here runs on the agent's behalf (see netguard.ts): the
// connection is made, and every call runs, inside the guard; the proxy
// connection is a socket file, which the guard leaves alone.
installNetGuard();
const guard = { internalPorts: () => start.internalPorts };
// Nothing Playwright leaves unhandled may end the thread.
process.on('unhandledRejection', reason => console.error('unhandled rejection (ignored):', reason));

// Calls to the gateway (the main thread).
let rpcId = 0;
const rpcWaiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function rpc<T>(method: string, ...args: any[]): Promise<T> {
  const id = ++rpcId;
  send({ type: 'rpc', id, method, args });
  return new Promise<T>((resolve, reject) => rpcWaiting.set(id, { resolve, reject }));
}

const targetIds = new WeakMap<Page, string>();
async function targetIdOf(page: Page): Promise<string> {
  let id = targetIds.get(page);
  if (id)
    return id;
  const cdp = await page.context().newCDPSession(page);
  try {
    id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId as string;
  } finally {
    await cdp.detach().catch(() => {});
  }
  targetIds.set(page, id);
  return id;
}

const host: ToolHost = {
  targetIdOf,
  emulation: new Map(start.emulation),
  offline: start.offline,
  internalPorts: start.internalPorts,
  allCookies: () => rpc('allCookies'),
  deleteCookies: cookies => rpc('deleteCookies', cookies),
  focusTab: targetId => rpc('focusTab', targetId),
  answerPermissions: (...args) => rpc('answerPermissions', ...args),
};

// The handler browser_route builds from its parameters (as upstream), for
// routes set up again on a new connection.
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

let browser: Browser;
let backend: any;

async function open() {
  const config = { ...start.config, outputDir: start.filesDir, allowUnrestrictedFileAccess: true };
  const tools = scopeTools([...pwTools.filteredTools(config), ...extraTools()]).filter((tool: any) => tool.schema.name !== 'browser_annotate');
  // As upstream connects to a CDP endpoint: traces (and download temp files)
  // go to the output folder's "traces".
  browser = await playwright.chromium.connectOverCDP(start.endpoint, { timeout: 15_000, artifactsDir: path.join(start.filesDir, 'traces') });
  backend = new pwTools.BrowserBackend(config, browser.contexts()[0], tools, async () => {});
  await backend.initialize({ cwd: start.filesDir, clientName: start.title });
  const context = backend._context;
  verifyContext(context);
  context._agentSession = host;
  patchContext(context);
  await context.ensureBrowserContext();
  // Set up again what the agent had before (a reconnect, a restart, a thread
  // that was ended).
  for (const params of start.routes)
    await context.addRoute({ ...params, handler: routeHandler(params) }).catch(() => {});
  if (start.offline)
    await browser.contexts()[0].setOffline(true).catch(() => {});
  for (const tab of context.tabs()) {
    const targetId = await targetIdOf(tab.page).catch(() => undefined);
    const settings = targetId && host.emulation.get(targetId);
    if (settings)
      await applyEmulation(tab.page, settings).catch(() => {});
    if (targetId && targetId === start.currentTarget)
      context._currentTab = tab;
  }
}

function patchContext(context: any) {
  let currentTab = context._currentTab;
  Object.defineProperty(context, '_currentTab', {
    configurable: true,
    get: () => currentTab,
    set: (tab: any) => {
      if (!callState.getStore()?.abandoned)
        currentTab = tab;
    },
  });
  // Tab headers that cannot hang (see patchTabHeader).
  const onPageCreated = context._onPageCreated.bind(context);
  context._onPageCreated = function(page: Page) {
    onPageCreated(page);
    const tab = this._tabs.find((tab: any) => tab.page === page);
    if (tab)
      patchTabHeader(tab);
  };
  for (const tab of context._tabs)
    patchTabHeader(tab);
}

// Every result lists the session's tabs with their titles; a page whose
// renderer is busy (an endless loop) never answers page.title(), which made
// every later call of the session hang too. Give up on the title after a while.
const headerTimeoutMs = 2000;

function patchTabHeader(tab: any) {
  if (tab.__headerPatched)
    return;
  tab.__headerPatched = true;
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

async function findTab(context: any, id: string) {
  for (const tab of context._tabs) {
    if ((await targetIdOf(tab.page)).startsWith(id.toUpperCase()))
      return tab;
  }
  return undefined;
}

// Stable ids for the `tab` parameter; indexes shift when tabs close.
async function tabIds(context: any) {
  const lines = [];
  for (const [index, tab] of context._tabs.entries()) {
    const id = (await targetIdOf(tab.page)).slice(0, 8);
    lines.push(`- ${index}: ${id}${tab === context._currentTab ? ' (current)' : ''}`);
  }
  return `### Tab ids\n${lines.join('\n')}\nPass "tab": "<id>" to any tool to act on that tab.`;
}

const calls = new Map<number, { abandoned: boolean }>();

async function call(id: number, name: string, args: any, tab: string | undefined): Promise<CallOutcome> {
  const context = backend._context;
  if (tab !== undefined) {
    await context.ensureBrowserContext();
    const target = await findTab(context, tab);
    if (!target)
      throw new Error(`Tab "${tab}" not found. Call browser_tabs to list your tabs.`);
    context._currentTab = target;
  }
  const state = { abandoned: false };
  calls.set(id, state);
  try {
    const result = await callState.run(state, () => backend.callTool(name, args));
    const disconnected = !browser.isConnected() || !!backend._disconnected;
    const current = disconnected ? undefined : context.currentTab()?.page;
    return {
      result,
      disconnected,
      disposed: !!backend._disposed,
      currentTarget: current ? await targetIdOf(current).catch(() => undefined) : undefined,
      currentUrl: current?.url(),
      tabIds: name === 'browser_tabs' && !result.isError && !disconnected ? await tabIds(context).catch(() => undefined) : undefined,
      ...snapshot(context),
    };
  } finally {
    calls.delete(id);
  }
}

// What the session keeps for a new connection.
function snapshot(context: any) {
  const routes = (context?.routes() ?? []).map(({ handler, ...params }: any) => params);
  // Routes added from code (browser_run_code_unsafe) are not in the list.
  const codeRoutes = ((browser?.contexts()[0] as any)?._routes?.length ?? 0) > routes.length;
  return { routes, codeRoutes, offline: host.offline, emulation: [...host.emulation] as [string, Emulation][] };
}

port.on('message', (message: ToWorker) => {
  switch (message.type) {
    case 'call':
      void agentCall.run(guard, () => call(message.id, message.name, message.args, message.tab)).then(
          outcome => send({ type: 'result', id: message.id, outcome }),
          error => send({ type: 'result', id: message.id, error: String((error as Error).message ?? error) }));
      return;
    case 'abandon': {
      const state = calls.get(message.id);
      if (state)
        state.abandoned = true;
      return;
    }
    case 'ping':
      send({ type: 'pong', n: message.n });
      return;
    case 'tab': {
      // The current tab, or the one at an index of browser_tabs' list.
      const context = backend?._context;
      const page: Page | undefined = (message.index === undefined ? context?.currentTab() : context?.tabs()[message.index])?.page;
      if (!page) {
        send({ type: 'tab', id: message.id });
        return;
      }
      void Promise.all([targetIdOf(page), page.title().catch(() => '')]).then(
          ([targetId, title]) => send({ type: 'tab', id: message.id, tab: { targetId, url: page.url(), title } }),
          () => send({ type: 'tab', id: message.id }));
      return;
    }
    case 'reply': {
      const waiting = rpcWaiting.get(message.id);
      rpcWaiting.delete(message.id);
      if (message.error !== undefined)
        waiting?.reject(new Error(message.error));
      else
        waiting?.resolve(message.value);
      return;
    }
  }
});

agentCall.run(guard, open).then(() => send({ type: 'ready' }), error => send({ type: 'failed', error: String((error as Error).message ?? error) }));
