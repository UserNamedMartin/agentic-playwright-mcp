// Nothing of one chat reaches another: chat B's pages carry a secret (in URLs,
// cookies, local storage, console output, requests, popups), and chat A tries
// every way to see or touch B found so far, from tools and from
// browser_run_code_unsafe. Every text A gets back and every file A saves is
// searched for the secret, and no call of A may leave a tab behind that is not
// A's own. Also checks that A's own views still work (popups, new pages,
// routes on first loads, recording and tracing next to B).
//
// Usage: node test/canary.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, site and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-canary-'));
const [cdpPort, gatewayPort] = [19461, 19462];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const pwCli = path.resolve(path.dirname(cli), '..', 'node_modules', 'playwright-core', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECRET = 'CANARY7f3a91';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`);
};

const page = who => `<!doctype html><title>${who} page</title><p>hello ${who}</p>
<button id=b onclick="window.__clicks=(window.__clicks||0)+1">Go</button>
<a id=blank href="/first-blank?who=${who}" target=_blank>blank</a>
<a id=probe href="/probe?who=${who}" target=_blank>probe</a>
<a id=dl href="/dl" download>dl</a>`;
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/redir-ok') {
    res.writeHead(302, { location: '/probe?redirected=1' });
    return res.end();
  }
  if (url.pathname === '/redir-cdp') {
    res.writeHead(302, { location: `http://127.0.0.1:${cdpPort}/json/list` });
    return res.end();
  }
  if (url.pathname === '/dl') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=b.bin' });
    return res.end('data');
  }
  if (url.pathname.startsWith('/first') || url.pathname.startsWith('/probe') || url.pathname.startsWith('/api')) {
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    return res.end(`<title>REAL ${url.pathname}</title>REAL`);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(url.searchParams.get('who') ?? 'X'));
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const port = site.address().port;
const urlA = `http://127.0.0.1:${port}/?who=A`;
const urlB = `http://localhost:${port}/?who=B&token=${SECRET}`;

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'ignore'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
// Another profile (not started): its ports are just as off limits.
const [otherGatewayPort, otherCdpPort] = [19463, 19464];
await new Promise(r => run('profile', 'add', 'other', '--headless', '--port', String(otherGatewayPort), '--cdp-port', String(otherCdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
for (let i = 0; i < 150; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

async function chat(id) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': id, 'x-agent-title': id, 'x-agent-pid': String(process.pid) } },
  });
  const client = new Client({ name: id, version: '1' });
  await client.connect(transport);
  const received = [];
  const call = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
      const text = r.content.map(c => c.text ?? '').join('\n');
      received.push(text);
      return { text, isError: !!r.isError };
    } catch (e) {
      received.push(e.message);
      return { text: `PROTOCOL ERROR ${e.message}`, isError: true };
    }
  };
  const code = async snippet => (await call('browser_run_code_unsafe', { code: snippet })).text;
  const result = text => { const m = text.match(/### Result\n([\s\S]*?)(\n###|$)/); try { return m ? JSON.parse(m[1]) : text; } catch { return m[1]; } };
  return { call, code, result, received, client };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter(t => t.type === 'page');
const tabIds = text => [...text.matchAll(/- \d+: ([0-9A-F]{8})/g)].map(m => m[1]);

try {
  const A = await chat('chat-A');
  const B = await chat('chat-B');

  // B's secret everywhere.
  await B.call('browser_navigate', { url: urlB });
  await B.call('browser_evaluate', { function: `() => { document.cookie = "b_secret=${SECRET}; path=/"; localStorage.setItem("b_secret", "${SECRET}"); console.log("${SECRET}"); fetch("/api?tok=${SECRET}"); return 1; }` });
  await B.call('browser_evaluate', { function: `() => { window.open("/probe?popup=${SECRET}"); return 1; }` });
  await B.call('browser_click', { element: 'blank', target: '#blank' });
  await sleep(500);
  const bTabs = tabIds((await B.call('browser_tabs', { action: 'list' })).text);
  await B.call('browser_tabs', { action: 'select', index: 0 });

  await A.call('browser_navigate', { url: urlA });
  // A's calls must not leave tabs that are not A's (or B's) behind.
  const known = async () => new Set([...tabIds((await A.call('browser_tabs', { action: 'list' })).text), ...bTabs, ...tabIds((await B.call('browser_tabs', { action: 'list' })).text)]);
  const strays = async before => {
    const own = await known();
    return (await targets()).filter(t => !before.has(t.id) && !own.has(t.id.slice(0, 8)) && !t.url.includes(`:${gatewayPort}`));
  };
  const beforeAll = new Set((await targets()).map(t => t.id));

  // Tools.
  await A.call('browser_tabs', { action: 'list' });
  await A.call('browser_snapshot');
  await A.call('browser_console_messages', { level: 'debug', all: true });
  await A.call('browser_network_requests', { static: true });
  await A.call('browser_cookie_list');
  await A.call('browser_cookie_get', { name: 'b_secret' });
  await A.call('browser_storage_state', { filename: 'state.json' });
  check('storage_state opens no tab', (await strays(beforeAll)).length === 0, JSON.stringify(await strays(beforeAll)));

  // Restoring local storage of a site no tab of A shows.
  const other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>other</title>'); }).listen(0, '127.0.0.1');
  await new Promise(r => other.on('listening', r));
  const otherOrigin = `http://127.0.0.1:${other.address().port}`;
  const stateFile = path.join(home, 'restore.json');
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [], origins: [{ origin: otherOrigin, localStorage: [{ name: 'restored', value: 'yes' }] }] }));
  const restore = await A.call('browser_set_storage_state', { filename: stateFile });
  check('set_storage_state for a site not open', !restore.isError, restore.text);
  await A.call('browser_tabs', { action: 'new', url: `${otherOrigin}/?who=A2` });
  check('its local storage was written', /yes/.test((await A.call('browser_evaluate', { function: '() => localStorage.getItem("restored")' })).text));
  await A.call('browser_tabs', { action: 'close' });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  check('no stray tabs so far', (await strays(beforeAll)).length === 0, JSON.stringify(await strays(beforeAll)));

  // The status page (every chat's tabs) is the user's: without its key, no
  // host name, request or route gets anything.
  for (const host of ['127.0.0.1', 'localhost', 'localhost.', '[::ffff:127.0.0.1]']) {
    await A.call('browser_navigate', { url: `http://${host}:${gatewayPort}/` });
    const text = (await A.call('browser_evaluate', { function: '() => document.body.innerText' })).text;
    check(`status page shows agents nothing (${host})`, !text.includes('chat-B') && !text.includes('who=B'), text.slice(0, 200));
  }
  await A.call('browser_navigate', { url: urlA });
  const viaRequest = await A.code(`async page => (await (await page.request.get('http://localhost.:${gatewayPort}/')).text())`);
  check('status page shows page.request nothing', !viaRequest.includes('chat-B'), viaRequest.slice(0, 200));
  const viaRoute = await A.code(`async page => { await page.route('**/via-route*', async route => route.fulfill({ response: await route.fetch({ url: 'http://127.0.0.1:${gatewayPort}/' }) })); await page.goto('${urlA}&via-route=1'.replace('?who', '/via-route?who')); return page.content(); }`);
  check('status page shows route.fetch nothing', !viaRoute.includes('chat-B'), viaRoute.slice(0, 200));
  await A.code('async page => { await page.unrouteAll(); return 1; }');
  await A.call('browser_navigate', { url: urlA });
  // The pinned home tab shows the chats (written over DevTools); no URL does.
  const { chromium } = (await import('playwright-core')).default;
  const viewer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  await sleep(5500);
  const homeTab = viewer.contexts()[0].pages().find(p => p.url().startsWith(`http://127.0.0.1:${gatewayPort}/`));
  const homeText = homeTab ? await homeTab.innerText('body') : '';
  await viewer.close();
  check('the pinned home tab lists the chats', homeText.includes('chat-B'), homeText.slice(0, 200));
  const anyUrlKnows = (await targets()).some(t => /key=/.test(t.url));
  check('no tab URL carries a status key', !anyUrlKnows);
  // The DevTools port and the gateway's pages (tab links raise the window)
  // are not for agents, by any path. The browser's own pages are.
  const bTab = (await targets()).find(t => t.url.includes('who=B'));
  const version = await A.call('browser_navigate', { url: 'chrome://version' });
  check('chrome:// pages are open to agents', !version.isError, version.text.slice(0, 120));
  const internal = [`http://127.0.0.1:${cdpPort}/json/list`, `http://localhost.:${cdpPort}/json/close/${bTab?.id}`,
    `view-source:http://127.0.0.1:${cdpPort}/json/version`, `http://[::1]:${cdpPort}/json`, `http://127.0.0.1:${gatewayPort}/focus?go=1`];
  for (const target of internal) {
    const nav = await A.call('browser_navigate', { url: target });
    check(`browser_navigate refuses ${target.slice(0, 40)}`, nav.isError && /not available to agents/.test(nav.text), nav.text.slice(0, 160));
  }
  for (const target of [`http://127.0.0.1:${otherGatewayPort}/focus?home=1`, `http://127.0.0.1:${otherCdpPort}/json/list`]) {
    const nav = await A.call('browser_navigate', { url: target });
    check(`another profile's ports are refused too (${target.slice(17, 40)})`, nav.isError && /not available to agents/.test(nav.text), nav.text.slice(0, 160));
  }
  const newTab = await A.call('browser_tabs', { action: 'new', url: `http://127.0.0.1:${cdpPort}/json/list` });
  check('browser_tabs new refuses the DevTools port', newTab.isError && /not available to agents/.test(newTab.text), newTab.text.slice(0, 160));
  await A.call('browser_navigate', { url: urlA });
  const codePaths = await A.code(`async page => {
    const out = [];
    const tryIt = async (name, fn) => out.push(await fn().then(() => name + ' WENT', e => /not available to agents/.test(e.message) ? name + ' refused' : name + ' other: ' + e.message.slice(0, 60)));
    await tryIt('goto', () => page.goto('http://localhost:${cdpPort}/json/list'));
    await tryIt('frame.goto', () => page.mainFrame().goto('http://127.0.0.1:${cdpPort}/json/list'));
    await tryIt('request', () => page.request.get('http://[::1]:${cdpPort}/json/list'));
    await tryIt('context.request', () => page.context().request.get('http://127.0.0.1:${cdpPort}/json/close/${bTab?.id}'));
    const cdp = await page.context().newCDPSession(page);
    await tryIt('cdp', () => cdp.send('Page.navigate', { url: 'http://127.0.0.1:${gatewayPort}/focus?home=1' }));
    await page.route('**/via-internal*', async route => { await tryIt('route.fetch', () => route.fetch({ url: 'http://127.0.0.1:${cdpPort}/json/list' })); await route.fulfill({ body: 'x' }); });
    await page.evaluate(() => fetch('/via-internal')).catch(() => {});
    await page.unrouteAll();
    return out.join(' | ');
  }`);
  const codeResult = codePaths.split('### Ran')[0];
  check('run_code: internal addresses refused by every path', !/WENT|other:/.test(codeResult) && (codeResult.match(/refused/g) ?? []).length === 6, codeResult);
  check('B\'s tab is still there', (await targets()).some(t => t.id === bTab?.id), 'B\'s tab was closed');
  // Getting there anyway (a redirect, the page's script, an iframe, the popup
  // binding): the tab is taken away at once.
  await A.call('browser_navigate', { url: `http://127.0.0.1:${port}/redir-cdp` });
  await sleep(500);
  const afterRedirect = await A.call('browser_evaluate', { function: '() => location.href' });
  check('a redirect to the DevTools port is left at once', /about:blank/.test(afterRedirect.text), afterRedirect.text.slice(0, 160));
  await A.call('browser_navigate', { url: urlA });
  await A.call('browser_evaluate', { function: `() => { location.href = 'http://127.0.0.1:${cdpPort}/json/list'; return 1; }` });
  await sleep(1000);
  const afterScript = await A.call('browser_snapshot');
  check('a page script sending the tab there is undone', !afterScript.text.includes('webSocketDebuggerUrl'), afterScript.text.slice(0, 160));
  await A.call('browser_navigate', { url: urlA });
  await A.call('browser_evaluate', { function: `() => { const f = document.createElement('iframe'); f.src = 'http://127.0.0.1:${cdpPort}/json/list'; document.body.append(f); return 1; }` });
  await sleep(1000);
  const afterFrame = await A.call('browser_snapshot');
  check('an iframe on the DevTools port is undone', !afterFrame.text.includes('webSocketDebuggerUrl'), afterFrame.text.slice(0, 160));
  await A.call('browser_evaluate', { function: `() => { window.__agenticOpenInBackground('http://127.0.0.1:${cdpPort}/json/list'); return 1; }` });
  await sleep(1000);
  check('the popup binding does not open the DevTools port', !(await targets()).some(t => t.url.includes(`:${cdpPort}/json`)), 'a tab is at the DevTools port');
  await A.call('browser_navigate', { url: urlA });
  await A.call('browser_navigate', { url: urlA });
  const viaRedirects = await A.code(`async page => {
    const out = [];
    const tryIt = async (name, fn) => out.push(await fn().then(r => name + ' GOT ' + r, e => /not available to agents/.test(e.message) ? name + ' refused' : name + ' other: ' + e.message.slice(0, 60)));
    await tryIt('request', async () => (await page.request.get('http://127.0.0.1:${port}/redir-cdp')).status());
    await tryIt('context.request', async () => (await page.context().request.fetch('http://127.0.0.1:${port}/redir-cdp', { maxRedirects: 5 })).status());
    await page.route('**/via-redir*', async route => { await tryIt('route.fetch', async () => (await route.fetch({ url: 'http://127.0.0.1:${port}/redir-cdp' })).status()); await route.fulfill({ body: 'x' }); });
    await page.evaluate(() => fetch('/via-redir')).catch(() => {});
    await page.unrouteAll();
    const ok = await page.request.get('http://127.0.0.1:${port}/redir-ok');
    out.push('normal redirect ' + ok.status() + ' ' + ok.url());
    return out.join(' | ');
  }`).then(t => t.split('### Ran')[0]);
  check('run_code: requests do not follow redirects to the DevTools port', (viaRedirects.match(/refused/g) ?? []).length === 3 && !/GOT|other:/.test(viaRedirects), viaRedirects);
  check('run_code: normal redirects still work', /normal redirect 200 .*redirected=1/.test(viaRedirects), viaRedirects);
  check('annotate is not offered', !(await A.client.listTools()).tools.some(t => t.name === 'browser_annotate'));
  const bTarget = (await targets()).find(t => t.url.includes('who=B'));
  const raise = await A.call('browser_open_tab_window', { targetId: bTarget?.id ?? 'none' });
  check('open_tab_window refuses another chat\'s tab', raise.isError, raise.text);

  // Cookie domains.
  await A.call('browser_cookie_set', { name: 'sid', value: '1', domain: 'example.test', path: '/' });
  await A.call('browser_cookie_set', { name: 'sid', value: '2', domain: 'notexample.test', path: '/' });
  await A.call('browser_cookie_delete', { name: 'sid', domain: 'example.test' });
  const left = await A.call('browser_cookie_list', { domain: 'notexample.test' });
  check('domain "example.test" does not match "notexample.test"', /sid=2/.test(left.text), left.text);

  // run_code: every way to the browser context shows only A's tabs.
  const paths = await A.code(`async page => {
    const urls = ctx => ctx.pages().map(p => p.url()).join(' ');
    return [
      urls(page.context()),
      urls(page.mainFrame().page().context()),
      urls(page.locator('body').page().context()),
      urls((await page.$('body')).ownerFrame ? (await (await page.$('body')).ownerFrame()).page().context() : page.context()),
      urls((await (await (await page.evaluateHandle(() => ({ el: document.body }))).getProperties()).get('el').asElement().ownerFrame()).page().context()),
      String(page.context().browser()),
      page.context().serviceWorkers().length + ' workers',
      JSON.stringify(await page.request.storageState()),
      JSON.stringify(await page.context().request.storageState()),
      JSON.stringify(await page.context().storageState()),
    ].join(' | ');
  }`);
  check('run_code: pages, frames, locators, handles lead only to A\'s tabs', paths.includes('who=A') && !paths.includes('who=B'), paths);

  // run_code: context-wide APIs.
  await B.call('browser_evaluate', { function: `() => { document.cookie = "b_keep=${SECRET}; path=/"; return 1; }` });
  const bCreateBefore = (await B.call('browser_evaluate', { function: '() => String(navigator.credentials.create)' })).text.split('### Ran')[0];
  const wide = await A.code(`async page => {
    const out = [];
    const cdp = await page.context().newCDPSession(page);
    for (const [method, params] of [['Target.getTargets', {}], ['Network.getAllCookies', {}], ['Storage.getCookies', {}], ['Browser.getVersion', {}]])
      out.push(await cdp.send(method, params).then(r => method + ' GOT ' + JSON.stringify(r).slice(0, 300), e => method + ' refused'));
    out.push(await cdp.send('Runtime.evaluate', { expression: '1+1' }).then(r => 'own runtime ' + r.result.value, e => 'own runtime refused'));
    out.push(await Promise.resolve().then(() => page.context().credentials.install({})).then(() => 'credentials installed', e => 'credentials refused'));
    await page.request.dispose();
    await page.context().clearCookies({ domain: /./ });
    return out.join(' | ');
  }`);
  check('run_code: CDP session only reaches its own tab', /Target.getTargets refused/.test(wide) && /getAllCookies refused/.test(wide) && /Storage.getCookies refused/.test(wide) && /own runtime 2/.test(wide), wide);
  await B.call('browser_navigate', { url: `${urlB}&after-credentials=1` });
  const bCreate = (await B.call('browser_evaluate', { function: '() => String(navigator.credentials.create)' })).text.split('### Ran')[0];
  check('run_code: context.credentials cannot replace B\'s passkey API', /credentials refused/.test(wide) && bCreate === bCreateBefore, `${wide} / B before: ${bCreateBefore.slice(0, 80)} after: ${bCreate.slice(0, 80)}`);
  const bRequest = await B.code(`async page => (await page.request.get('${urlB.replace('?who', 'api?who')}')).status()`);
  check('run_code: A\'s page.request.dispose() leaves B\'s working', /200/.test(bRequest), bRequest);
  check('run_code: clearCookies with a domain pattern leaves B\'s cookies', (await B.call('browser_evaluate', { function: '() => document.cookie' })).text.includes('b_keep'), 'B lost its cookie');

  // run_code: shared recorder mode, debugger, download behavior.
  const shared = await A.code(`async page => {
    const out = [];
    for (const name of ['pickLocator', 'cancelPickLocator', 'pause'])
      out.push(await page[name]().then(() => name + ' RAN', e => /not available here/.test(e.message) ? name + ' refused' : name + ' other ' + e.message.slice(0, 40)));
    const cdp = await page.context().newCDPSession(page);
    for (const method of ['Page.setDownloadBehavior', 'ServiceWorker.stopAllWorkers'])
      out.push(await cdp.send(method, method.startsWith('Page') ? { behavior: 'deny' } : {}).then(() => method + ' RAN', () => method + ' refused'));
    return out.join(' | ');
  }`).then(t => t.split('### Ran')[0]);
  check('run_code: shared recorder mode, debugger and download behavior refused', (shared.match(/refused/g) ?? []).length === 5, shared);

  // run_code: objects handed to callbacks and option predicates.
  const handedIn = await A.code(`async page => {
    const seen = [];
    await page.exposeBinding('peek', source => { seen.push('binding: ' + source.context.pages().map(p => p.url()).join(' ')); });
    await page.evaluate(() => window.peek());
    const request = page.waitForEvent('request', { predicate: r => { seen.push('predicate: ' + r.frame().page().context().pages().map(p => p.url()).join(' ')); return true; } });
    await page.evaluate(() => fetch('/api?own=1'));
    await request;
    return seen.join(' | ');
  }`);
  check('run_code: callback sources and option predicates lead only to A\'s tabs', handedIn.includes('binding:') && handedIn.includes('predicate:') && !handedIn.includes('who=B'), handedIn);

  // run_code: context events while B is busy.
  const listening = A.code(`async page => {
    const seen = [];
    const ctx = page.context();
    const describe = x => x ? (x.url ? x.url() : x.text ? x.text() : x.message ? x.message() : x.suggestedFilename ? x.suggestedFilename() : String(x)) : String(x);
    for (const event of ['request', 'response', 'console', 'dialog', 'requestfinished', 'pageload', 'pageclose', 'framenavigated', 'frameattached', 'framedetached', 'download', 'page', 'weberror'])
      ctx.on(event, x => seen.push(event + ':' + describe(x)));
    ctx.prependListener('request', x => seen.push('prepend:' + describe(x)));
    ctx.prependOnceListener('response', x => seen.push('prepend-once:' + describe(x)));
    ctx.on('dialog', d => d.accept('HIJACKED'));
    const waited = await ctx.waitForEvent('response', { timeout: 2500 }).then(r => 'got ' + r.url(), () => 'none');
    return JSON.stringify({ seen, waited });
  }`);
  await sleep(300);
  await B.call('browser_evaluate', { function: `() => { fetch("/api?again=${SECRET}"); console.log("again ${SECRET}"); return 1; }` });
  await B.call('browser_navigate', { url: `${urlB}&step=2` });
  await B.call('browser_tabs', { action: 'new', url: `${urlB}&step=3` });
  await B.call('browser_tabs', { action: 'close' });
  await B.call('browser_tabs', { action: 'select', index: 0 });
  await B.call('browser_click', { element: 'dl', target: '#dl' });
  const events = await listening;
  check('run_code: context events of B not delivered to A', !events.includes('who=B') && !events.includes(SECRET) && /waited\W+none/.test(events), events);
  await B.call('browser_evaluate', { function: '() => { setTimeout(() => window.__answer = prompt("q?"), 50); return 1; }' });
  await sleep(500);
  const bDialog = await B.call('browser_snapshot');
  check('a listener A left behind does not answer B\'s dialog', /prompt/.test(bDialog.text) && /q\?/.test(bDialog.text), bDialog.text.slice(0, 200));
  await B.call('browser_handle_dialog', { accept: true, promptText: 'from-B' });

  // run_code: the same page is the same object; popup listeners of every kind.
  const identity = await A.code(`async page => {
    const same = page.context().pages().includes(page) && page.context().pages()[0] === page;
    let calls = 0;
    const f = () => calls++;
    const chained = page.on('popup', f).off('popup', f) === page;
    const got = [];
    page.addListener('popup', p => got.push('add'));
    page.prependListener('popup', p => got.push('prepend'));
    await Promise.all([page.waitForEvent('popup'), page.click('#probe')]);
    await page.waitForTimeout(200);
    return JSON.stringify({ same, chained, calls, got });
  }`);
  check('run_code: one object per page, popup listeners of every kind', /same\W+true/.test(identity) && /chained\W+true/.test(identity) && /calls\W+0/.test(identity) && /add/.test(identity) && /prepend/.test(identity), identity);
  const tabsNow = (await A.call('browser_tabs', { action: 'list' })).text;
  for (let i = tabIds(tabsNow).length - 1; i >= 1; i--)
    await A.call('browser_tabs', { action: 'close', index: i });
  await A.call('browser_tabs', { action: 'select', index: 0 });

  // run_code: A's own popups and new pages, as upstream.
  const popup = await A.code(`async page => { const [p] = await Promise.all([page.waitForEvent('popup'), page.click('#probe')]); await p.waitForLoadState(); return 'popup ' + p.url(); }`);
  check('page.waitForEvent("popup") gets a target=_blank tab', /popup .*probe\?who=A/.test(popup), popup);
  const newPageEvent = await A.code(`async page => { const [p] = await Promise.all([page.context().waitForEvent('page'), page.context().newPage()]); return 'new ' + p.url(); }`);
  check('context.waitForEvent("page") gets newPage()', /new about:blank/.test(newPageEvent), newPageEvent);
  const blankEvent = await A.code(`async page => { const [p] = await Promise.all([page.context().waitForEvent('page'), page.click('#probe')]); return 'blank ' + p.url(); }`);
  check('context.waitForEvent("page") gets a target=_blank tab', /blank/.test(blankEvent) && !/Timeout/.test(blankEvent), blankEvent);
  const current = await A.call('browser_evaluate', { function: '() => location.href' });
  check('newPage() leaves the current tab alone', current.text.includes('who=A'), current.text);
  const zero = await A.code(`async page => { const p = page.context().waitForEvent('page', { timeout: 0 }); await page.waitForTimeout(300); const fresh = await page.context().newPage(); return (await p) === fresh ? 'same' : 'resolved'; }`);
  check('waitForEvent timeout 0 means no timeout', /same|resolved/.test(zero), zero);
  const aTabs = (await A.call('browser_tabs', { action: 'list' })).text;
  for (let i = tabIds(aTabs).length - 1; i >= 1; i--)
    await A.call('browser_tabs', { action: 'close', index: i });
  await A.call('browser_tabs', { action: 'select', index: 0 });

  // Routes and offline mode reach tabs A's page opens, from their first load.
  await A.call('browser_route', { pattern: '**/first-blank*', body: 'MOCKED-FIRST' });
  await A.call('browser_click', { element: 'blank', target: '#blank' });
  await sleep(1000);
  await A.call('browser_tabs', { action: 'select', index: 1 });
  const firstLoad = await A.call('browser_evaluate', { function: '() => document.body.innerText' });
  check('route applies to a target=_blank tab\'s first load', firstLoad.text.includes('MOCKED-FIRST'), firstLoad.text);
  await A.call('browser_tabs', { action: 'close' });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  await A.call('browser_evaluate', { function: '() => { window.open("/first-blank?popup=1"); return 1; }' });
  await sleep(1000);
  await A.call('browser_tabs', { action: 'select', index: 1 });
  const popupLoad = await A.call('browser_evaluate', { function: '() => document.body.innerText' });
  check('route applies to a window.open popup\'s first load', popupLoad.text.includes('MOCKED-FIRST'), popupLoad.text);
  await A.call('browser_tabs', { action: 'close' });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  await A.call('browser_unroute', {});
  const bUnrouted = await B.call('browser_evaluate', { function: '() => fetch("/first-blank?b=1").then(r => r.text())' });
  check('A\'s routes never answered B', bUnrouted.text.includes('REAL'), bUnrouted.text);
  await A.call('browser_network_state_set', { state: 'offline' });
  await A.call('browser_click', { element: 'probe', target: '#probe' });
  await sleep(1000);
  await A.call('browser_tabs', { action: 'select', index: 1 });
  const offlineLoad = await A.call('browser_evaluate', { function: '() => document.body.innerText' });
  check('offline applies to a new tab\'s first load', !offlineLoad.text.includes('REAL'), offlineLoad.text);
  await A.call('browser_tabs', { action: 'close' });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  await A.call('browser_network_state_set', { state: 'online' });

  // Two chats open the same popup URL, each with its own route for it: each
  // popup's first load is answered by its own chat's route, never the other's.
  await B.call('browser_route', { pattern: '**/probe?same=*', body: 'B-ROUTED' });
  await B.call('browser_evaluate', { function: `() => { window.open("http://127.0.0.1:${port}/probe?same=1"); return 1; }` });
  await sleep(1500);
  await A.call('browser_route', { pattern: '**/probe?same=*', body: 'A-ROUTED' });
  await A.call('browser_evaluate', { function: `() => { window.open("http://127.0.0.1:${port}/probe?same=1"); return 1; }` });
  await sleep(1500);
  await A.call('browser_tabs', { action: 'select', index: 1 });
  const samePopup = await A.call('browser_evaluate', { function: '() => document.body.innerText' });
  check('a popup is never answered by another chat\'s route', !samePopup.text.includes('B-ROUTED'), samePopup.text);
  check('... and gets its own chat\'s', samePopup.text.includes('A-ROUTED'), samePopup.text);
  await A.call('browser_tabs', { action: 'close' });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  await A.call('browser_unroute', {});
  await B.call('browser_unroute', {});

  // One chat stopping while another starts: the second still records.
  await A.call('browser_start_recording');
  await Promise.all([A.call('browser_stop_recording'), B.call('browser_start_recording')]);
  await B.call('browser_click', { element: 'Go', target: '#b' });
  const afterRace = await B.call('browser_stop_recording');
  check('a recording started while another chat stops still records', /click/.test(afterRace.text), afterRace.text.slice(0, 200));

  // Recording and tracing next to each other: each gets only its own.
  const [recA, recB] = await Promise.all([A.call('browser_start_recording'), B.call('browser_start_recording')]);
  check('two chats can record at once', !recA.isError && !recB.isError, recA.text + ' / ' + recB.text);
  await Promise.all([A.call('browser_start_tracing'), B.call('browser_start_tracing')]);
  await B.call('browser_navigate', { url: `${urlB}&recorded=1` });
  await B.call('browser_click', { element: 'Go', target: '#b' });
  await A.call('browser_click', { element: 'Go', target: '#b' });
  const recordedA = await A.call('browser_stop_recording');
  const recordedB = await B.call('browser_stop_recording');
  check('B\'s recording kept going after A stopped', !recordedB.isError, recordedB.text);
  const traced = await A.call('browser_stop_tracing');
  await B.call('browser_stop_tracing');
  const traceFile = traced.text.match(/(\/\S+\.zip)/)?.[1];
  let traceText = '';
  if (traceFile) {
    const cwd = fs.mkdtempSync(path.join(home, 'trace-'));
    const pw = (...args) => execFileSync(process.execPath, [pwCli, 'trace', ...args], { cwd, encoding: 'utf8' });
    pw('open', traceFile);
    traceText = ['actions', 'console', 'requests'].map(c => pw(c)).join('\n');
    A.received.push(traceText);
  }
  check('A\'s trace loads', traceText.length > 0, traced.text);

  // Every text A got, and every file A saved.
  const files = [];
  const walk = dir => fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true }).forEach(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : files.push(path.join(dir, e.name)));
  walk(path.join(home, 'profiles', 'test', 'files', 'chat-A'));
  const textFiles = files.filter(f => /\.(json|md|yml|yaml|txt|log|js|ts|html)$/.test(f));
  const leakedIn = [...A.received.map((t, i) => [`result ${i}`, t]), ...textFiles.map(f => [f, fs.readFileSync(f, 'utf8')])]
      .filter(([, text]) => text.includes(SECRET) || text.includes('who=B'))
      .map(([where, text]) => `${where}: …${text.slice(Math.max(0, text.search(new RegExp(`${SECRET}|who=B`)) - 80), text.search(new RegExp(`${SECRET}|who=B`)) + 40)}…`);
  check(`nothing of B in anything A got (${A.received.length} results, ${textFiles.length} files)`, leakedIn.length === 0, leakedIn.join(' || '));
  check('A\'s recording has only A\'s actions', /click/.test(recordedA.text) && !recordedA.text.includes('recorded=1'), recordedA.text);
  check('no stray tabs at the end', (await strays(beforeAll)).length === 0, JSON.stringify(await strays(beforeAll)));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  gateway.kill('SIGINT');
  await sleep(1500);
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
