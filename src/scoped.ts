// Cookie and storage tools scoped to the calling session. Upstream they act on
// the whole browser context, which it owns alone; here the context is shared,
// so "clear all cookies" or "export storage state" would reach every other chat
// and the user's own logins. They act on the sites of the session's own tabs
// instead; list and delete still reach another site when the agent names its
// domain explicitly.
import fs from 'node:fs';
import type { BrowserContext, Cookie } from 'playwright-core';
import { z } from './internals.js';
import { isolatedView } from './isolation.js';

// Sites (http and https URLs) of the session's open tabs.
export function ownUrls(context: any): string[] {
  return context.tabs().map((tab: any) => tab.page.url()).filter((url: string) => /^https?:/.test(url));
}

export async function ownCookies(context: any): Promise<Cookie[]> {
  const urls = ownUrls(context);
  if (!urls.length)
    return [];
  const browserContext: BrowserContext = await context.ensureBrowserContext();
  return await browserContext.cookies(urls);
}

const describe = (c: Cookie) => `${c.name}=${c.value} (domain: ${c.domain}, path: ${c.path})`;
const scopeNote = 'Only cookies of the sites open in your tabs; pass "domain" for another site.';

function domainMatches(cookie: Cookie, domain: string) {
  return cookie.domain.includes(domain);
}

async function removeCookies(browserContext: BrowserContext, cookies: Cookie[]) {
  for (const c of cookies)
    await browserContext.clearCookies({ name: c.name, domain: c.domain, path: c.path });
}

// Cookies and local storage of the sites open in the session's tabs.
export async function scopedStorageState(context: any) {
  const browserContext: BrowserContext = await context.ensureBrowserContext();
  const state = await browserContext.storageState();
  const own = new Set((await ownCookies(context)).map(c => `${c.name}\n${c.domain}\n${c.path}`));
  const origins = new Set(ownUrls(context).map(u => new URL(u).origin));
  return {
    cookies: state.cookies.filter(c => own.has(`${c.name}\n${c.domain}\n${c.path}`)),
    origins: state.origins.filter(o => origins.has(o.origin)),
  };
}

// Replaces the cookies and local storage of the sites in `state` only.
export async function applyStorageState(context: any, state: any) {
  const browserContext: BrowserContext = await context.ensureBrowserContext();
  const cookies: Cookie[] = state.cookies ?? [];
  for (const domain of new Set(cookies.map(c => c.domain)))
    await browserContext.clearCookies({ domain });
  if (cookies.length)
    await browserContext.addCookies(cookies);
  const origins: { origin: string; localStorage: { name: string; value: string }[] }[] = state.origins ?? [];
  if (origins.length) {
    // Written over CDP from one of the session's own tabs, so no page has
    // to be opened on each origin (upstream opens one, in the foreground).
    const tab = await context.ensureTab();
    const cdp = await browserContext.newCDPSession(tab.page);
    try {
      for (const { origin, localStorage } of origins) {
        const storageId = { securityOrigin: origin, isLocalStorage: true };
        await cdp.send('DOMStorage.clear', { storageId });
        for (const { name, value } of localStorage)
          await cdp.send('DOMStorage.setDOMStorageItem', { storageId, key: name, value });
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
  return { cookies: cookies.length, origins: origins.length };
}

// Tracing and the recorder can only work on the whole browser context, so one
// session at a time may use them; they stop when that session ends.
type ContextWide = 'tracing' | 'recording';
const owners = new WeakMap<object, Partial<Record<ContextWide, any>>>();
const ownersOf = (browserContext: object) => {
  let entry = owners.get(browserContext);
  if (!entry)
    owners.set(browserContext, entry = {});
  return entry;
};

function exclusiveStart(kind: ContextWide, what: string) {
  return async (context: any, params: any, response: any, original: any) => {
    const entry = ownersOf(await context.ensureBrowserContext());
    const owner = entry[kind];
    if (owner && owner !== context._agentSession)
      throw new Error(`Another chat (${owner.info.title}) is using ${what} right now; it covers the whole shared browser, so only one chat at a time can. Try again later.`);
    await original(context, params, response);
    entry[kind] = context._agentSession;
  };
}

function exclusiveStop(kind: ContextWide, what: string) {
  return async (context: any, params: any, response: any, original: any) => {
    const entry = ownersOf(await context.ensureBrowserContext());
    const owner = entry[kind];
    if (owner && owner !== context._agentSession)
      throw new Error(`${what} was started by another chat (${owner.info.title}); only that chat can stop it.`);
    if (!owner && kind === 'tracing')
      throw new Error('Tracing is not started');
    await original(context, params, response);
    delete entry[kind];
  };
}

// Called when a session ends: stops whatever context-wide thing it left on.
export async function releaseContextWide(session: any, browserContext: any) {
  const entry = owners.get(browserContext);
  if (!entry)
    return;
  if (entry.tracing === session) {
    delete entry.tracing;
    await browserContext.tracing.stop().catch(() => {});
  }
  if (entry.recording === session) {
    delete entry.recording;
    await browserContext._disableRecorder?.().catch(() => {});
  }
}

const replacements: Record<string, { description?: string; inputSchema?: any; handle: (context: any, params: any, response: any, original: any) => Promise<void> }> = {
  browser_network_state_set: {
    description: 'Take your tabs offline or back online. Other chats share this browser and are not affected.',
    handle: async (context, params, response) => {
      await context._agentSession.setOffline(params.state === 'offline');
      response.addTextResult(`Network is now ${params.state} in your tabs`);
      response.addCode(`await page.context().setOffline(${params.state === 'offline'});`);
    },
  },
  browser_start_tracing: { handle: exclusiveStart('tracing', 'tracing') },
  browser_stop_tracing: { handle: exclusiveStop('tracing', 'Tracing') },
  browser_start_recording: { handle: exclusiveStart('recording', 'the action recorder') },
  browser_stop_recording: { handle: exclusiveStop('recording', 'The action recorder') },
  browser_cookie_list: {
    description: 'List the cookies of the sites open in your tabs (or of "domain", if given). Other chats share this browser, so other sites are left out by default.',
    handle: async (context, params, response) => {
      const browserContext: BrowserContext = await context.ensureBrowserContext();
      let cookies = params.domain
        ? (await browserContext.cookies()).filter(c => domainMatches(c, params.domain))
        : await ownCookies(context);
      if (params.path)
        cookies = cookies.filter(c => c.path.startsWith(params.path));
      response.addTextResult(cookies.length ? cookies.map(describe).join('\n') : `No cookies found. ${params.domain ? '' : scopeNote}`);
      response.addCode(`await page.context().cookies();`);
    },
  },
  browser_cookie_get: {
    description: 'Get a cookie by name from the sites open in your tabs.',
    handle: async (context, params, response) => {
      const cookie = (await ownCookies(context)).find(c => c.name === params.name);
      response.addTextResult(cookie
        ? `${describe(cookie)}, httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure}, sameSite: ${cookie.sameSite}`
        : `Cookie '${params.name}' not found. ${scopeNote}`);
      response.addCode(`await page.context().cookies();`);
    },
  },
  browser_cookie_delete: {
    description: 'Delete a cookie by name from the sites open in your tabs (or from "domain", if given). Other chats share this browser, so other sites are left alone by default.',
    inputSchema: z.object({
      name: z.string().describe('Cookie name to delete'),
      domain: z.string().optional().describe('Delete it on this domain instead of the sites of your tabs.'),
    }),
    handle: async (context, params, response) => {
      const browserContext: BrowserContext = await context.ensureBrowserContext();
      const candidates = params.domain
        ? (await browserContext.cookies()).filter(c => domainMatches(c, params.domain))
        : await ownCookies(context);
      const matching = candidates.filter(c => c.name === params.name);
      await removeCookies(browserContext, matching);
      response.addTextResult(matching.length
        ? `Deleted ${matching.map(c => `${c.name} (domain: ${c.domain})`).join(', ')}`
        : `Cookie '${params.name}' not found. ${scopeNote}`);
      response.addCode(`await page.context().clearCookies({ name: ${JSON.stringify(params.name)} });`);
    },
  },
  browser_cookie_clear: {
    description: 'Clear the cookies of the sites open in your tabs. Other chats share this browser, so other sites (and the user\'s logins there) are left alone.',
    handle: async (context, params, response) => {
      const browserContext: BrowserContext = await context.ensureBrowserContext();
      const cookies = await ownCookies(context);
      await removeCookies(browserContext, cookies);
      const sites = [...new Set(ownUrls(context).map(u => new URL(u).hostname))];
      response.addTextResult(sites.length
        ? `Cleared ${cookies.length} cookie(s) of ${sites.join(', ')}`
        : 'No site is open in your tabs, so no cookies were cleared.');
      response.addCode(`await page.context().clearCookies();`);
    },
  },
  browser_storage_state: {
    description: 'Save the cookies and local storage of the sites open in your tabs to a file. Other chats share this browser, so other sites are left out.',
    handle: async (context, params, response) => {
      const scoped = await scopedStorageState(context);
      const file = await response.resolveClientOutputFile({ prefix: 'storage-state', ext: 'json', suggestedFilename: params.filename }, 'Storage state');
      response.addCode(`await page.context().storageState({ path: ${JSON.stringify(file.relativeName)} });`);
      await response.addFileResult(file, JSON.stringify(scoped, null, 2));
    },
  },
  browser_set_storage_state: {
    description: 'Restore cookies and local storage from a storage state file. Only the sites in the file are replaced; other sites keep their cookies and storage.',
    handle: async (context, params, response) => {
      const file = await response.resolveClientFilename(params.filename);
      const { cookies, origins } = await applyStorageState(context, JSON.parse(fs.readFileSync(file, 'utf8')));
      response.addTextResult(`Storage state restored from ${params.filename}: ${cookies} cookie(s), local storage of ${origins} origin(s)`);
      response.addCode(`await page.context().setStorageState(${JSON.stringify(params.filename)});`);
    },
  },
  browser_run_code_unsafe: {
    handle: async (context, params, response, original) => await original(isolatedView(context), params, response),
  },
};

export function scopeTools(tools: any[]) {
  return tools.map(tool => {
    const replacement = replacements[tool.schema.name];
    if (!replacement)
      return tool;
    return {
      ...tool,
      schema: {
        ...tool.schema,
        description: replacement.description ?? tool.schema.description,
        inputSchema: replacement.inputSchema ?? tool.schema.inputSchema,
      },
      handle: (context: any, params: any, response: any) => replacement.handle(context, params, response, tool.handle),
    };
  });
}
