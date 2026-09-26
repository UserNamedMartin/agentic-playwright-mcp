// Every tool, two sessions: does the tool work at all, does using it in
// session A reach session B (a different chat on another site), and what is
// left behind once A's chat is gone. Upstream Playwright MCP assumes one agent
// owns the whole browser context; here many share one, so anything that acts
// on the context instead of a page shows up in this table.
//
// Usage: node test/matrix.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, site and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check (ok / LEAK / BROKEN /
// note) and exits non-zero if any LEAK or BROKEN was found. browser_show_tab
// and browser_annotate are left out: one raises the browser window, the other
// opens the Playwright Dashboard for the user (see CLAUDE.md).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-matrix-'));
const [cdpPort, gatewayPort] = [19401, 19402];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rows = [];
const covered = new Set();
const record = (tool, check, status, detail = '') => {
  rows.push({ tool, check, status, detail });
  const mark = { ok: 'ok    ', LEAK: 'LEAK  ', BROKEN: 'BROKEN', note: 'note  ' }[status];
  console.log(`${mark} ${tool.padEnd(28)} ${check}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
};
const expect = (tool, check, ok, detail, bad = 'LEAK') => record(tool, check, ok ? 'ok' : bad, ok ? '' : detail);

// Two origins, so A and B are different sites like two real chats would be.
const page = who => `<!doctype html><title>${who} page</title>
<p>hello world ${who}</p>
<input id=t aria-label=field><button id=b onclick="window.__clicks=(window.__clicks||0)+1">Go</button>
<select id=s aria-label=pick><option value=1>one</option><option value=2>two</option></select>
<input id=c type=checkbox aria-label=tick>
<ul id=l aria-label=things><li>alpha</li><li>beta</li></ul>
<div id=src draggable=true>drag me</div><div id=dst style="width:80px;height:40px;border:1px solid" ondragover="event.preventDefault()">drop here</div>
<input id=f type=file aria-label=upload>
<a id=dl href="/dl" download>download</a>
<script>
window.__log = [];
for (const e of ['keydown', 'input', 'click', 'resize', 'drop', 'dragstart'])
  addEventListener(e, ev => __log.push(e + ':' + (ev.target.id || 'window')), true);
console.log('${who}-CONSOLE');
fetch('/${who.toLowerCase()}-only').catch(() => {});
</script>`;
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/dl') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=file.bin' });
    return res.end('data');
  }
  if (url.pathname.startsWith('/probe') || url.pathname.startsWith('/left') || url.pathname.endsWith('-only')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    return res.end('REAL');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(url.searchParams.get('who') ?? 'X'));
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const port = site.address().port;
const urlA = `http://127.0.0.1:${port}/?who=A`;
const urlB = `http://localhost:${port}/?who=B`;

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
let gatewayLog = '';
gateway.stderr.on('data', d => gatewayLog += d);
let gatewayExit;
gateway.on('exit', code => gatewayExit = code);
for (let i = 0; i < 150; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

// A chat is alive while its pid is: each session gets its own sleeper process,
// killed to end the chat (the gateway sweeps dead chats every 15 s).
const chats = [];
async function chat(id) {
  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': id, 'x-agent-title': id, 'x-agent-pid': String(sleeper.pid) } },
  });
  const client = new Client({ name: id, version: '1' });
  await client.connect(transport);
  const c = {
    id, sleeper, client,
    // Never throws: a protocol error or a hang is part of the result.
    async call(name, args = {}, seconds = 30) {
      covered.add(name);
      try {
        const result = await Promise.race([
          client.callTool({ name, arguments: args }, undefined, { timeout: seconds * 1000 + 5000 }),
          sleep(seconds * 1000 + 6000).then(() => ({ hang: true })),
        ]);
        if (result.hang)
          return { text: 'NO ANSWER', protocolError: true, isError: true };
        return { text: result.content.map(x => x.text ?? '').join('\n'), isError: !!result.isError, protocolError: false };
      } catch (e) {
        return { text: `PROTOCOL ERROR ${e.message}`, isError: true, protocolError: true };
      }
    },
    async eval(fn) {
      const r = await this.call('browser_evaluate', { function: fn });
      const m = r.text.match(/### Result\n([\s\S]*?)(\n###|$)/);
      try {
        return m ? JSON.parse(m[1]) : r.text;
      } catch {
        return m[1];
      }
    },
    end() {
      sleeper.kill();
    },
  };
  chats.push(c);
  return c;
}
const waitForSweep = async ids => {
  for (let i = 0; i < 40; i++) {
    if (ids.every(id => gatewayLog.includes(`session closed: ${id}`)))
      return true;
    await sleep(1000);
  }
  return false;
};
const cdpPages = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter(t => t.type === 'page');
const works = (tool, r, check = 'works') => {
  if (r.protocolError)
    record(tool, check, 'BROKEN', r.text);
  else if (r.isError)
    record(tool, check, 'BROKEN', r.text.replace(/^### Error\n/, ''));
  else
    record(tool, check, 'ok');
  return r;
};
// B's page logs every input event it gets; any entry after A acted is a leak.
const bQuiet = async (tool, B) => {
  const log = await B.eval('() => { const l = window.__log.slice(); window.__log.length = 0; return l; }');
  expect(tool, 'B page got no events from A', Array.isArray(log) && log.length === 0, JSON.stringify(log));
};

try {
  const A = await chat('chat-A');
  const B = await chat('chat-B');
  await B.call('browser_navigate', { url: urlB });
  await B.eval('() => { document.cookie = "b_cookie=1; path=/"; localStorage.setItem("b_key", "1"); sessionStorage.setItem("b_sess", "1"); return 1; }');
  const bBaseline = await B.eval('() => ({ w: innerWidth, h: innerHeight, ua: navigator.userAgent })');

  // --- Page tools: they must work in A and never touch B's page.
  works('browser_navigate', await A.call('browser_navigate', { url: urlA }));
  await sleep(300);
  works('browser_snapshot', await A.call('browser_snapshot'));
  works('browser_find', await A.call('browser_find', { text: 'hello' }));
  works('browser_generate_locator', await A.call('browser_generate_locator', { element: 'Go', target: '#b' }));
  works('browser_highlight', await A.call('browser_highlight', { element: 'Go', target: '#b' }));
  works('browser_hide_highlight', await A.call('browser_hide_highlight', {}));
  works('browser_take_screenshot', await A.call('browser_take_screenshot', { scale: 'css' }));
  const pdf = await A.call('browser_pdf_save', {});
  works('browser_pdf_save', pdf);
  const pdfPath = pdf.text.match(/(\/\S+\.pdf)/)?.[1];
  expect('browser_pdf_save', 'saves a PDF file', pdfPath && fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).subarray(0, 4).toString() === '%PDF', pdf.text, 'BROKEN');
  for (const [tool, args] of [
    ['browser_click', { element: 'Go', target: '#b' }],
    ['browser_hover', { element: 'Go', target: '#b' }],
    ['browser_type', { element: 'field', target: '#t', text: 'abc' }],
    ['browser_press_key', { key: 'x' }],
    ['browser_fill_form', { fields: [{ name: 'field', type: 'textbox', target: '#t', value: 'filled' }, { name: 'tick', type: 'checkbox', target: '#c', value: 'true' }] }],
    ['browser_select_option', { element: 'pick', target: '#s', values: ['2'] }],
    ['browser_drag', { startElement: 'drag me', startTarget: '#src', endElement: 'drop here', endTarget: '#dst' }],
    ['browser_drop', { element: 'drop here', target: '#dst', data: { 'text/plain': 'x' } }],
  ]) {
    works(tool, await A.call(tool, args));
    await bQuiet(tool, B);
  }
  // Coordinate mouse tools (vision).
  const box = await A.eval('() => { const r = document.getElementById("b").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }');
  for (const [tool, args] of [
    ['browser_mouse_move_xy', { x: box.x, y: box.y }],
    ['browser_mouse_click_xy', { x: box.x, y: box.y }],
    ['browser_mouse_down', {}],
    ['browser_mouse_up', {}],
    ['browser_mouse_wheel', { deltaX: 0, deltaY: 50 }],
    ['browser_mouse_drag_xy', { startX: box.x, startY: box.y, endX: box.x + 40, endY: box.y }],
  ]) {
    works(tool, await A.call(tool, args));
    await bQuiet(tool, B);
  }
  const aGot = await A.eval('() => window.__log.join(" ")');
  expect('browser_click', 'A page got the input', /click:b/.test(aGot) && /input:t/.test(aGot), aGot, 'BROKEN');
  works('browser_verify_element_visible', await A.call('browser_verify_element_visible', { role: 'button', accessibleName: 'Go' }));
  works('browser_verify_text_visible', await A.call('browser_verify_text_visible', { text: 'hello world A' }));
  works('browser_verify_list_visible', await A.call('browser_verify_list_visible', { element: 'things', target: '#l', items: ['alpha', 'beta'] }));
  works('browser_verify_value', await A.call('browser_verify_value', { type: 'textbox', element: 'field', target: '#t', value: 'filled' }));
  works('browser_wait_for', await A.call('browser_wait_for', { time: 1 }));
  works('browser_evaluate', await A.call('browser_evaluate', { function: '() => 1' }));
  // run_code's page: the browser seen through it holds only A's tabs.
  const runCode = async (who, code) => (await who.call('browser_run_code_unsafe', { code })).text;
  const code = await A.call('browser_run_code_unsafe', { code: 'async page => page.context().pages().map(p => p.url()).join(" ")' });
  works('browser_run_code_unsafe', code);
  expect('browser_run_code_unsafe', 'context().pages() lists only A\'s tabs', !code.text.includes('who=B') && code.text.includes('who=A'), code.text);
  expect('browser_run_code_unsafe', 'context().browser() is not reachable', /null/.test(await runCode(A, 'async page => String(page.context().browser())')), '');
  await B.eval('() => { document.cookie = "b_run=1; path=/"; return 1; }');
  await runCode(A, 'async page => { await page.context().clearCookies(); return "cleared"; }');
  expect('browser_run_code_unsafe', 'context().clearCookies() leaves B\'s cookies', (await B.eval('() => document.cookie')).includes('b_run'), 'B lost its cookie');
  await runCode(A, 'async page => { await page.context().route("**/probe-run*", r => r.fulfill({ body: "RUN-HIJACK" })); return 1; }');
  const runRouted = await B.eval(`() => fetch('/probe-run').then(r => r.text(), () => 'FAILED')`);
  expect('browser_run_code_unsafe', 'context().route() does not reach B', runRouted === 'REAL', `B got ${runRouted}`);
  const aRouted = await A.eval(`() => fetch('/probe-run').then(r => r.text(), () => 'FAILED')`);
  expect('browser_run_code_unsafe', 'context().route() works for A', aRouted === 'RUN-HIJACK', `A got ${aRouted}`, 'BROKEN');
  await runCode(A, 'async page => { await page.context().unrouteAll(); return 1; }');
  await runCode(A, 'async page => { await page.context().setOffline(true); return 1; }');
  const runOffline = await B.eval(`() => fetch('/probe-run-off').then(r => r.text(), () => 'FAILED')`);
  expect('browser_run_code_unsafe', 'context().setOffline() does not reach B', runOffline === 'REAL', `B: ${runOffline}`);
  await runCode(A, 'async page => { await page.context().setOffline(false); return 1; }');
  const refusedInit = await runCode(A, 'async page => { await page.context().addInitScript("1"); return "ran"; }');
  expect('browser_run_code_unsafe', 'context-wide addInitScript refused with a hint', /not available here[\s\S]*page\.addInitScript/.test(refusedInit), refusedInit);
  const newPage = await runCode(A, `async page => { const p = await page.context().newPage(); await p.goto(${JSON.stringify(urlA + '&run=new')}); return page.context().pages().length; }`);
  const tabsAfterNew = await A.call('browser_tabs', { action: 'list' });
  expect('browser_run_code_unsafe', 'context().newPage() is one of A\'s tabs', tabsAfterNew.text.includes('run=new'), `${newPage} / ${tabsAfterNew.text}`, 'BROKEN');
  expect('browser_run_code_unsafe', 'context().newPage() not in B\'s tabs', !(await B.call('browser_tabs', { action: 'list' })).text.includes('run=new'), 'B lists it');
  await A.call('browser_tabs', { action: 'close' });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  const waiting = A.call('browser_run_code_unsafe', { code: 'async page => { try { const p = await page.context().waitForEvent("page", { timeout: 2500 }); return "got " + p.url(); } catch (e) { return "none"; } }' });
  await sleep(500);
  await B.call('browser_tabs', { action: 'new', url: `${urlB}&bnew=1` });
  await B.call('browser_tabs', { action: 'close' });
  await B.call('browser_tabs', { action: 'select', index: 0 });
  const waited = (await waiting).text;
  expect('browser_run_code_unsafe', 'waitForEvent("page") ignores B\'s new tab', /none/.test(waited), waited);
  const popup = await runCode(A, 'async page => { const [p] = await Promise.all([page.context().waitForEvent("page"), page.evaluate(() => window.open(location.href + "&popup=1"))]); return "got " + p.url(); }');
  expect('browser_run_code_unsafe', 'waitForEvent("page") sees A\'s popup', /popup=1/.test(popup), popup, 'BROKEN');
  await A.call('browser_tabs', { action: 'close', index: 1 });
  await A.call('browser_tabs', { action: 'select', index: 0 });
  const D = await chat('chat-D');
  await D.call('browser_navigate', { url: `${urlA}&d=1` });
  await runCode(D, 'async page => { await page.context().close(); return 1; }');
  await sleep(500);
  expect('browser_run_code_unsafe', 'context().close() closes only its own tabs', (await B.eval('() => location.href')).includes('who=B') && !(await cdpPages()).some(p => p.url.includes('d=1')), 'B\'s tab or D\'s tab state wrong');

  // Tabs: only A's own.
  const tabsA = await A.call('browser_tabs', { action: 'list' });
  works('browser_tabs', tabsA, 'list works');
  expect('browser_tabs', 'list shows only own tabs', !tabsA.text.includes('who=B'), tabsA.text);
  works('browser_tabs', await A.call('browser_tabs', { action: 'new', url: `${urlA}&tab=2` }), 'new works');
  works('browser_tabs', await A.call('browser_tabs', { action: 'select', index: 0 }), 'select works');
  works('browser_tabs', await A.call('browser_tabs', { action: 'close', index: 1 }), 'close works');
  works('browser_navigate_back', await A.call('browser_navigate_back'));
  await A.call('browser_navigate', { url: urlA });
  const link = await A.call('browser_tab_link', { index: 0 });
  works('browser_tab_link', link);
  expect('browser_tab_link', 'index 1 (not A\'s) refused', /No such tab/.test((await A.call('browser_tab_link', { index: 5 })).text), '', 'BROKEN');

  // Console and network logs: only the session's own pages.
  const consoleA = await A.call('browser_console_messages', { level: 'debug', all: true });
  works('browser_console_messages', consoleA);
  expect('browser_console_messages', 'no B messages in A', !consoleA.text.includes('B-CONSOLE'), consoleA.text);
  const netA = await A.call('browser_network_requests', { static: true });
  works('browser_network_requests', netA);
  expect('browser_network_requests', 'no B requests in A', !netA.text.includes('b-only'), netA.text);
  works('browser_network_request', await A.call('browser_network_request', { index: 1, part: 'response-headers' }));

  // Cookies and storage state: one cookie jar for the whole browser, so the
  // tools must stay on the sites of the session's own tabs.
  works('browser_cookie_set', await A.call('browser_cookie_set', { name: 'a_cookie', value: '1', domain: '127.0.0.1', path: '/' }));
  await B.eval('() => { document.cookie = "same=b; path=/"; return 1; }');
  await A.eval('() => { document.cookie = "same=a; path=/"; return 1; }');
  const cookiesB = await B.call('browser_cookie_list');
  works('browser_cookie_list', cookiesB);
  expect('browser_cookie_list', 'B does not see A\'s cookies', !cookiesB.text.includes('a_cookie'), 'lists every site\'s cookies, including the user\'s logins');
  expect('browser_cookie_list', 'B sees its own cookies', cookiesB.text.includes('b_cookie'), cookiesB.text, 'BROKEN');
  const explicit = await B.call('browser_cookie_list', { domain: '127.0.0.1' });
  expect('browser_cookie_list', 'an explicit domain still works', explicit.text.includes('a_cookie'), explicit.text, 'BROKEN');
  const getB = await A.call('browser_cookie_get', { name: 'b_cookie' });
  works('browser_cookie_get', getB);
  expect('browser_cookie_get', 'A cannot read B\'s cookie', /not found/i.test(getB.text), getB.text);
  expect('browser_cookie_get', 'A reads its own cookie', /a_cookie=1/.test((await A.call('browser_cookie_get', { name: 'a_cookie' })).text), '', 'BROKEN');
  works('browser_cookie_delete', await A.call('browser_cookie_delete', { name: 'same' }));
  expect('browser_cookie_delete', 'B\'s same-named cookie survives A\'s delete', (await B.eval('() => document.cookie')).includes('same=b'), 'A deleted B\'s cookie');
  expect('browser_cookie_delete', 'A\'s own cookie is deleted', !(await A.eval('() => document.cookie')).includes('same=a'), '', 'BROKEN');
  works('browser_cookie_clear', await A.call('browser_cookie_clear'));
  expect('browser_cookie_clear', 'B\'s cookie survives A\'s clear', (await B.eval('() => document.cookie')).includes('b_cookie'), 'A wiped every cookie in the browser (all logins)');
  expect('browser_cookie_clear', 'A\'s own cookies are cleared', !(await A.call('browser_cookie_list')).text.includes('a_cookie'), '', 'BROKEN');
  await B.eval('() => { document.cookie = "b_cookie=1; path=/"; return 1; }');
  await A.eval('() => { document.cookie = "a_cookie=1; path=/"; localStorage.setItem("a_saved", "1"); return 1; }');

  const state = await A.call('browser_storage_state', { filename: 'state.json' });
  works('browser_storage_state', state);
  const statePath = state.text.match(/\((\/[^)]*state\.json)\)/)?.[1] ?? state.text.match(/(\/\S*state\.json)/)?.[1];
  const stateText = statePath && fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  expect('browser_storage_state', 'export has no B data', !stateText.includes('b_cookie') && !stateText.includes('b_key'), 'exports every site\'s cookies and storage, including the user\'s logins');
  expect('browser_storage_state', 'export has A\'s own data', stateText.includes('a_cookie') && stateText.includes('a_saved'), stateText.slice(0, 200), 'BROKEN');
  const pagesBefore = (await cdpPages()).length;
  // A state of A's own, without B's cookie: loading it must not touch B.
  const ownState = path.join(home, 'own-state.json');
  fs.writeFileSync(ownState, JSON.stringify({
    cookies: [{ name: 'a_state', value: '1', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: `http://127.0.0.1:${port}`, localStorage: [{ name: 'a_restored', value: 'yes' }] }],
  }));
  const setState = await A.call('browser_set_storage_state', { filename: ownState });
  works('browser_set_storage_state', setState);
  expect('browser_set_storage_state', 'B\'s cookie survives', (await B.eval('() => document.cookie')).includes('b_cookie'), 'replaces the whole cookie jar');
  const restored = await A.eval('() => document.cookie + " " + localStorage.getItem("a_restored")');
  expect('browser_set_storage_state', 'A\'s cookie and local storage restored', /a_state=1/.test(restored) && /yes/.test(restored), restored, 'BROKEN');
  await sleep(500);
  expect('browser_set_storage_state', 'opens no extra tab', (await cdpPages()).length <= pagesBefore, `${pagesBefore} -> ${(await cdpPages()).length} pages`);
  await B.eval('() => { document.cookie = "b_cookie=1; path=/"; localStorage.setItem("b_key", "1"); return 1; }');

  // Web storage: per origin, so A's calls on its own site must not touch B's.
  for (const kind of ['localstorage', 'sessionstorage']) {
    works(`browser_${kind}_set`, await A.call(`browser_${kind}_set`, { key: 'a_key', value: '1' }));
    works(`browser_${kind}_get`, await A.call(`browser_${kind}_get`, { key: 'a_key' }));
    const list = await A.call(`browser_${kind}_list`);
    works(`browser_${kind}_list`, list);
    expect(`browser_${kind}_list`, 'no B keys in A', !list.text.includes('b_key') && !list.text.includes('b_sess'), list.text);
    works(`browser_${kind}_delete`, await A.call(`browser_${kind}_delete`, { key: 'a_key' }));
    works(`browser_${kind}_clear`, await A.call(`browser_${kind}_clear`));
  }
  expect('browser_localstorage_clear', 'B\'s storage survives', (await B.eval('() => localStorage.getItem("b_key") + sessionStorage.getItem("b_sess")')) === '11', 'B lost storage');

  // Network state and routes.
  works('browser_network_state_set', await A.call('browser_network_state_set', { state: 'offline' }));
  const offlineB = await B.eval(`() => fetch('/probe-offline').then(r => r.text(), e => 'FAILED')`);
  expect('browser_network_state_set', 'B stays online', offlineB === 'REAL', `B's fetch: ${offlineB}`);
  await A.call('browser_network_state_set', { state: 'online' });
  works('browser_route', await A.call('browser_route', { pattern: '**/probe-route*', body: 'HIJACKED' }));
  const routedB = await B.eval(`() => fetch('/probe-route').then(r => r.text(), e => 'FAILED')`);
  expect('browser_route', 'B not routed by A', routedB === 'REAL', `B's fetch got ${routedB}`);
  const routesB = await B.call('browser_route_list');
  works('browser_route_list', routesB);
  record('browser_route_list', 'B sees routes affecting it', routedB !== 'REAL' && /No active routes/i.test(routesB.text) ? 'LEAK' : 'ok',
    routedB !== 'REAL' && /No active routes/i.test(routesB.text) ? 'B is routed by A but its list is empty' : '');
  works('browser_unroute', await A.call('browser_unroute', { pattern: '**/probe-route*' }));
  expect('browser_unroute', 'B unrouted again', (await B.eval(`() => fetch('/probe-route2').then(r => r.text())`)) === 'REAL', 'still routed');

  // Emulation and window size.
  works('browser_resize', await A.call('browser_resize', { width: 500, height: 400 }));
  let bNow = await B.eval('() => ({ w: innerWidth, h: innerHeight, ua: navigator.userAgent })');
  expect('browser_resize', 'B keeps its size', bNow.w === bBaseline.w && bNow.h === bBaseline.h, `${bBaseline.w}x${bBaseline.h} -> ${bNow.w}x${bNow.h}`);
  works('browser_emulate_device', await A.call('browser_emulate_device', { device: 'iPhone 15' }));
  bNow = await B.eval('() => ({ w: innerWidth, h: innerHeight, ua: navigator.userAgent })');
  expect('browser_emulate_device', 'B keeps its device', bNow.ua === bBaseline.ua && bNow.w === bBaseline.w, `B: ${bNow.w}x${bNow.h} ${bNow.ua.slice(0, 40)}`);
  works('browser_emulate_device', await A.call('browser_emulate_device', { reset: true }), 'reset works');
  const aAfterReset = await A.eval('() => ({ w: innerWidth, ua: navigator.userAgent })');
  expect('browser_emulate_device', 'reset restores A (no iPhone UA)', !/iPhone/.test(aAfterReset.ua), aAfterReset.ua, 'BROKEN');

  // Tracing.
  works('browser_start_tracing', await A.call('browser_start_tracing'));
  // Tracing runs once for the whole browser; each chat gets only its own tabs.
  const traceB = await B.call('browser_start_tracing');
  expect('browser_start_tracing', 'B can trace while A does', !traceB.isError, traceB.text, 'BROKEN');
  await B.eval('() => { console.log("B-TRACED"); return 1; }');
  await A.eval('() => { console.log("A-TRACED"); return 1; }');
  const stopB = await B.call('browser_stop_tracing');
  works('browser_stop_tracing', stopB, 'B stops its own trace');
  const stopA = await A.call('browser_stop_tracing');
  works('browser_stop_tracing', stopA, 'A stops its own trace');
  expect('browser_stop_tracing', 'A\'s trace saved in A\'s folder', !stopA.text.includes('chat-B'), stopA.text);
  // Read with Playwright's own trace loader (npx playwright trace ...).
  const zipText = result => {
    const file = result.text.match(/(\/\S+\.zip)/)?.[1];
    if (!file || !fs.existsSync(file))
      return '';
    const cwd = fs.mkdtempSync(path.join(home, 'trace-'));
    const pw = path.resolve(path.dirname(cli), '..', 'node_modules', 'playwright-core', 'cli.js');
    const run = (...args) => execFileSync(process.execPath, [pw, 'trace', ...args], { cwd, encoding: 'utf8' });
    run('open', file);
    return ['actions', 'console', 'requests'].map(command => run(command)).join('\n');
  };
  const traceA = zipText(stopA);
  const traceBText = zipText(stopB);
  expect('browser_stop_tracing', 'A\'s trace loads with A\'s actions and console', /Evaluate/.test(traceA) && traceA.includes('A-TRACED'), traceA.slice(0, 300), 'BROKEN');
  const zipEntries = result => execFileSync('unzip', ['-l', result.text.match(/(\/\S+\.zip)/)?.[1] ?? '/nonexistent'], { encoding: 'utf8' });
  expect('browser_stop_tracing', 'A\'s trace has its screenshots', /screencast\//.test(zipEntries(stopA)), zipEntries(stopA), 'BROKEN');
  expect('browser_stop_tracing', 'A\'s trace has nothing of B', !traceA.includes('who=B') && !traceA.includes('B-TRACED'), 'B found in A\'s trace');
  expect('browser_stop_tracing', 'B\'s trace has nothing of A', traceBText.length > 0 && !traceBText.includes('who=A') && !traceBText.includes('A-TRACED'), 'A found in B\'s trace');

  // Video.
  works('browser_start_video', await A.call('browser_start_video', {}));
  works('browser_video_chapter', await A.call('browser_video_chapter', { title: 'one' }));
  works('browser_video_show_actions', await A.call('browser_video_show_actions', {}));
  await A.call('browser_click', { element: 'Go', target: '#b' });
  works('browser_video_hide_actions', await A.call('browser_video_hide_actions'));
  const video = await A.call('browser_stop_video');
  works('browser_stop_video', video);
  const videos = video.text.match(/\.webm/g)?.length ?? 0;
  expect('browser_start_video', 'records only A\'s tabs', videos <= 1, `${videos} videos for 1 tab`);

  // Recorder: it can only be enabled on the whole context, so its (hidden)
  // overlay reaches B's pages; what matters is that B keeps working and that
  // A's recording holds only A's actions.
  works('browser_start_recording', await A.call('browser_start_recording'));
  await sleep(500);
  const recB = await B.eval('() => [...new Set([...document.querySelectorAll("*")].map(e => e.tagName).filter(t => t.startsWith("X-PW")))].join(",") || false');
  record('browser_start_recording', 'recorder overlay in B\'s page', recB ? 'note' : 'ok', recB ? `${recB} (context-wide in Playwright)` : '');
  await B.eval('() => { window.__clicks = 0; return 1; }');
  await B.call('browser_click', { element: 'Go', target: '#b' });
  expect('browser_start_recording', 'B\'s clicks still reach B\'s page', (await B.eval('() => window.__clicks')) === 1, 'click swallowed by the recorder', 'BROKEN');
  await A.call('browser_click', { element: 'Go', target: '#b' });
  const recording = await A.call('browser_stop_recording');
  works('browser_stop_recording', recording);
  expect('browser_start_recording', 'A\'s recording has no B actions', !/localhost|who=B/.test(recording.text), recording.text);
  const resume = await A.call('browser_resume', {});
  record('browser_resume', 'answers when nothing is paused', !resume.protocolError && /not paused/i.test(resume.text) ? 'ok' : 'BROKEN', resume.text);

  // Modal states that start in B's page must stay B's.
  await B.eval('() => { setTimeout(() => alert("B alert"), 50); return 1; }');
  await sleep(300);
  const snapA = await A.call('browser_snapshot');
  expect('browser_handle_dialog', 'A not told about B\'s dialog', !snapA.text.includes('B alert'), snapA.text);
  const dialogB = await B.call('browser_snapshot');
  expect('browser_handle_dialog', 'B is told about its dialog', dialogB.text.includes('B alert'), dialogB.text, 'BROKEN');
  works('browser_handle_dialog', await B.call('browser_handle_dialog', { accept: true }));
  await B.call('browser_click', { element: 'upload', target: '#f' });
  const snapA2 = await A.call('browser_snapshot');
  expect('browser_file_upload', 'A not told about B\'s file chooser', !/file chooser/i.test(snapA2.text), snapA2.text);
  works('browser_file_upload', await B.call('browser_file_upload', {}));
  const dl = await B.call('browser_click', { element: 'download', target: '#dl' });
  await sleep(1000);
  const snapA3 = await A.call('browser_snapshot');
  expect('browser_click', 'A not told about B\'s download', !/file\.bin/.test(snapA3.text), snapA3.text);
  const dlB = dl.text + (await B.call('browser_snapshot')).text;
  expect('browser_click', 'B is told about its download', /file\.bin/.test(dlB), dlB, 'BROKEN');

  // Gateway tools.
  const perm = await A.call('browser_permission', { decision: 'deny' });
  record('browser_permission', 'answers without a pending request', perm.protocolError ? 'BROKEN' : 'ok', perm.protocolError ? perm.text : '');
  const sub = await A.call('browser_subagent_start', { label: 'helper' });
  works('browser_subagent_start', sub);
  const subId = sub.text.match(/"agent":\s*"([^"]+)"|agent[^\n]*?"([^"]+)"|id[:\s]+([\w-]+)/)?.slice(1).find(Boolean);
  if (subId) {
    await A.call('browser_navigate', { url: `${urlA}&sub=1`, agent: subId });
    const parentTabs = await A.call('browser_tabs', { action: 'list' });
    const [ownPart, subPart = ''] = parentTabs.text.split("### Your subagents' tabs");
    expect('browser_subagent_start', 'the subagent\'s tab is not one of the parent\'s', !ownPart.includes('sub=1'), parentTabs.text, 'BROKEN');
    expect('browser_subagent_start', 'the parent sees its subagent\'s tab', subPart.includes('sub=1'), parentTabs.text, 'BROKEN');
    expect('browser_subagent_start', 'B does not see A\'s subagent', !(await B.call('browser_tabs', { action: 'list' })).text.includes('sub=1'), 'B lists it');
  } else {
    record('browser_subagent_start', 'returns an agent id', 'note', sub.text.slice(0, 200));
  }
  const bogus = await A.call('browser_open_tab_window', { targetId: 'NOPE' });
  expect('browser_open_tab_window', 'a failure is an error result, not a protocol error', bogus.isError && !bogus.protocolError, bogus.text, 'BROKEN');
  // browser_close: must close A's tabs and leave A usable.
  const C = await chat('chat-C');
  await C.call('browser_navigate', { url: `${urlA}&c=1` });
  works('browser_close', await C.call('browser_close'));
  await sleep(500);
  const leftC = (await cdpPages()).filter(p => p.url.includes('c=1')).length;
  expect('browser_close', 'closes the session\'s tabs', leftC === 0, `${leftC} tab(s) left open, invisible to the agent`, 'BROKEN');
  const afterClose = await C.call('browser_navigate', { url: `${urlA}&c=2` });
  works('browser_close', afterClose, 'session usable after close');

  // --- Leftovers: a chat changes shared state and ends without undoing it.
  const L = await chat('chat-L');
  await L.call('browser_navigate', { url: `${urlA}&l=1` });
  await L.call('browser_route', { pattern: '**/left*', body: 'LEFTOVER' });
  await L.call('browser_start_tracing');
  await L.call('browser_start_video', {});
  await L.call('browser_emulate_device', { device: 'iPhone 15' });
  await L.call('browser_start_recording');
  L.end();
  const swept = await waitForSweep(['chat-L']);
  record('(session end)', 'dead chat is swept', swept ? 'ok' : 'BROKEN', swept ? '' : 'chat-L not closed');
  const leftRoute = await B.eval(`() => fetch('/left').then(r => r.text(), () => 'FAILED')`);
  expect('browser_route', 'route gone when its chat ends', leftRoute === 'REAL', `B's fetch still gets ${leftRoute}`);
  const leftTrace = await B.call('browser_start_tracing');
  expect('browser_start_tracing', 'trace stopped when its chat ends', !leftTrace.isError, leftTrace.text);
  if (!leftTrace.isError)
    await B.call('browser_stop_tracing');
  await B.call('browser_navigate', { url: `${urlB}&after=1` });
  await B.eval('() => { window.__clicks = 0; return 1; }');
  await B.call('browser_click', { element: 'Go', target: '#b' });
  expect('browser_start_recording', 'recorder off when its chat ends (clicks reach B)', (await B.eval('() => window.__clicks')) === 1, 'click swallowed');
  const glass = await B.eval('() => { const g = document.querySelector("x-pw-glass"); return g ? getComputedStyle(g).display + "/" + getComputedStyle(g).pointerEvents : "none-left"; }');
  expect('browser_start_recording', 'recorder overlay inert when its chat ends', /^none|\/none$|none-left/.test(glass), `x-pw-glass is ${glass}`);
  const leftPages = (await cdpPages()).filter(p => p.url.includes('l=1')).length;
  expect('(session end)', 'its tabs are closed', leftPages === 0, `${leftPages} tab(s) left`, 'BROKEN');

  const O = await chat('chat-O');
  await O.call('browser_navigate', { url: `${urlA}&o=1` });
  await O.call('browser_network_state_set', { state: 'offline' });
  O.end();
  await waitForSweep(['chat-O']);
  const leftOffline = await B.eval(`() => fetch('/probe-after-offline').then(r => r.text(), () => 'FAILED')`);
  expect('browser_network_state_set', 'online again when its chat ends', leftOffline === 'REAL', `B's fetch: ${leftOffline}`);

  record('(gateway)', 'still running', gatewayExit === undefined ? 'ok' : 'BROKEN', `exit code ${gatewayExit}`);
  const all = new Set(JSON.parse(JSON.stringify((await A.client.listTools()).tools.map(t => t.name))));
  const missed = [...all].filter(t => !covered.has(t) && !['browser_show_tab', 'browser_annotate', 'browser_open_tab_window'].includes(t));
  record('(matrix)', 'every tool exercised', missed.length ? 'note' : 'ok', missed.join(', '));
} catch (e) {
  record('(matrix)', 'ran to the end', 'BROKEN', e.stack);
} finally {
  for (const c of chats)
    c.end();
  gateway.kill('SIGINT');
  await sleep(1500);
  site.close();
  const count = s => rows.filter(r => r.status === s).length;
  console.log(`\n${rows.length} checks: ${count('ok')} ok, ${count('LEAK')} LEAK, ${count('BROKEN')} BROKEN, ${count('note')} note`);
  process.exit(count('LEAK') + count('BROKEN') ? 1 : 0);
}
