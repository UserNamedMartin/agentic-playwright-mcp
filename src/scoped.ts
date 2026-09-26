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
import { startTracing, stopRecording, stopTracing } from './recording.js';

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

// A cookie of `domain` or one of its subdomains ("example.com" matches
// "www.example.com", not "notexample.com").
function domainMatches(cookie: Cookie, domain: string) {
  const wanted = domain.replace(/^\./, '').toLowerCase();
  const actual = cookie.domain.replace(/^\./, '').toLowerCase();
  return actual === wanted || actual.endsWith(`.${wanted}`);
}

async function removeCookies(browserContext: BrowserContext, cookies: Cookie[]) {
  for (const c of cookies)
    await browserContext.clearCookies({ name: c.name, domain: c.domain, path: c.path });
}

// Cookies and local storage of the sites open in the session's tabs. Read
// from those tabs: browserContext.storageState() would visit every origin the
// browser has seen, in a new foreground tab.
export async function scopedStorageState(context: any) {
  const cookies = await ownCookies(context);
  const origins: { origin: string; localStorage: { name: string; value: string }[] }[] = [];
  const seen = new Set<string>();
  for (const tab of context.tabs()) {
    const url: string = tab.page.url();
    if (!/^https?:/.test(url))
      continue;
    const origin = new URL(url).origin;
    if (seen.has(origin))
      continue;
    seen.add(origin);
    const read = tab.page.evaluate(() => Object.entries(localStorage).map(([name, value]) => ({ name, value: String(value) })));
    const localStorage = await Promise.race([read, new Promise<undefined>(r => setTimeout(() => r(undefined), 2000))]).catch(() => undefined);
    if (localStorage?.length)
      origins.push({ origin, localStorage });
  }
  return { cookies, origins };
}

// Replaces the cookies and local storage of the sites in `state` only. Local
// storage of an origin none of the session's tabs shows is written from a
// scratch background tab that never reaches the network.
export async function applyStorageState(context: any, state: any) {
  const browserContext: BrowserContext = await context.ensureBrowserContext();
  const cookies: Cookie[] = state.cookies ?? [];
  for (const domain of new Set(cookies.map(c => c.domain)))
    await browserContext.clearCookies({ domain });
  if (cookies.length)
    await browserContext.addCookies(cookies);
  const origins: { origin: string; localStorage: { name: string; value: string }[] }[] = state.origins ?? [];
  const write = (items: { name: string; value: string }[]) => {
    localStorage.clear();
    for (const { name, value } of items)
      localStorage.setItem(name, value);
  };
  for (const { origin, localStorage: items } of origins) {
    const tab = context.tabs().find((t: any) => { try { return new URL(t.page.url()).origin === origin; } catch { return false; } });
    if (tab) {
      await tab.page.evaluate(write, items);
      continue;
    }
    await context._agentSession.withScratchPage(async (page: any) => {
      await page.route(`${origin}/**`, (route: any) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
      await page.goto(`${origin}/`);
      await page.evaluate(write, items);
    });
  }
  return { cookies: cookies.length, origins: origins.length };
}

// Called when a session ends or closes its browser: it stops recording and
// tracing (see recording.ts).
export async function releaseContextWide(session: any, context: any) {
  if (!context)
    return;
  await stopRecording(session, context).catch(() => {});
  await stopTracing(session, context, true).catch(() => {});
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
  browser_start_tracing: {
    description: 'Start trace recording of your tabs (actions, snapshots, screenshots, console, network).',
    handle: async (context, params, response) => {
      await startTracing(context._agentSession, context);
      response.addTextResult('Trace recording started. Only your own tabs are recorded; call browser_stop_tracing to get the trace.');
    },
  },
  browser_stop_tracing: {
    description: 'Stop trace recording and save the trace of your tabs.',
    handle: async (context, params, response) => {
      const zip = await stopTracing(context._agentSession, context);
      const file = await response.resolveClientOutputFile({ prefix: 'trace', ext: 'zip' }, 'Trace');
      await response.addFileResult(file, zip);
      response.addTextResult('Trace recording stopped. Open the trace with: npx playwright show-trace <file>');
    },
  },
  // Stock start_recording also brings the tab to the front, which raises the
  // window over whatever the user is doing.
  browser_start_recording: {
    handle: async (context, params, response) => {
      await context.ensureTab();
      await context.startRecording();
      response.addTextResult('Recording started. Call browser_stop_recording to retrieve the recorded actions.');
    },
  },
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
