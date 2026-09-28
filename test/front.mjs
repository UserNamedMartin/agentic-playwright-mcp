// While nobody can see the browser, the status page stays in front of its
// window whatever the agents do. Chrome does not draw the tab in front of a
// minimized window or a hidden browser, so an agent's tab left there stops
// rendering and its screenshots never answer. A headless browser counts as
// out of sight, so every check here holds the gateway to that.
//
// Usage: node test/front.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, site, scratch
// AGENTIC_PLAYWRIGHT_HOME and fake desktop chat files (for forks, found through
// AGENTIC_CLAUDE_APP_SUPPORT). Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from 'playwright-core';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-front-'));
const appSupport = path.join(home, 'app-support');
const chatsDir = path.join(appSupport, 'Claude-test', 'claude-code-sessions', 'account', 'org');
fs.mkdirSync(chatsDir, { recursive: true });
const writeChat = (id, chat) => fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({ sessionId: id, ...chat }));
const [cdpPort, gatewayPort] = [19481, 19482];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, AGENTIC_CLAUDE_APP_SUPPORT: appSupport };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>${req.url}</title><p>${req.url}</p>
<a id=blank href="/from-blank" target=_blank>blank</a>
<button id=open onclick="window.open('/from-open')">open</button>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const base = `http://127.0.0.1:${site.address().port}`;
// localhost and 127.0.0.1 are different sites: a new renderer process.
const otherSite = base.replace('127.0.0.1', 'localhost');
const statusPage = `http://127.0.0.1:${gatewayPort}/`;

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'ignore'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const startGateway = async () => {
  const gateway = run('start', 'test');
  for (let i = 0; i < 150; i++) {
    if (await fetch(statusPage).then(r => r.ok, () => false))
      break;
    await sleep(200);
  }
  return gateway;
};
let gateway = await startGateway();

const connect = async (chatId, title) => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': chatId, 'x-agent-desktop-chat': chatId, 'x-agent-title': title, 'x-agent-pid': String(process.pid) } },
  });
  const client = new Client({ name: 'front-test', version: '1' });
  await client.connect(transport);
  return async (name, args = {}) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })).content.map(c => c.text ?? '').join('\n');
};

// The test's own view of the browser, only to read which tab is in front.
let browser;
const frontTab = async () => {
  for (let i = 0; i < 30; i++) {
    for (const worker of browser.contexts()[0]?.serviceWorkers() ?? []) {
      if (await worker.evaluate(() => typeof self.apmPing === 'function').catch(() => false))
        return await worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(t => t.url).join(', '));
    }
    await sleep(200);
  }
  return 'no extension worker';
};
// Chrome settles the front tab a moment after a tab opens or closes.
const statusInFront = async (name) => {
  await sleep(700);
  const front = await frontTab();
  check(`${name}: the status page is in front`, front === statusPage, front);
};

try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  await statusInFront('at start');

  writeChat('local_a', { title: 'A' });
  const a = await connect('local_a', 'A');
  await a('browser_navigate', { url: `${base}/one` });
  await statusInFront('a chat opens its first tab');
  await a('browser_tabs', { action: 'new', url: `${base}/two` });
  await statusInFront('a chat opens another tab');
  await a('browser_click', { element: 'blank link', target: '#blank' });
  await statusInFront('a target=_blank link');
  await a('browser_click', { element: 'open button', target: '#open' });
  await statusInFront('window.open');
  await a('browser_navigate', { url: `${otherSite}/cross-site` });
  await statusInFront('a cross-site navigation');

  // A fork's copies are made by the browser's "Duplicate", which puts the
  // copy in front.
  writeChat('local_fork', { title: 'A (fork)', forkedFromSessionId: 'local_a' });
  const fork = await connect('local_fork', 'A (fork)');
  const forkTabs = await fork('browser_tabs', { action: 'list' });
  check('the fork got copies', /Tabs of the original chat/.test(forkTabs), forkTabs.split('\n').slice(0, 3).join(' '));
  await statusInFront('a fork copies tabs');

  // Closing a tab makes Chrome pick another one for the front, maybe another
  // chat's.
  await fork('browser_tabs', { action: 'close', index: 0 });
  await statusInFront('a fork closes a tab');
  await a('browser_tabs', { action: 'close' });
  await statusInFront('a chat closes its current tab');

  writeChat('local_b', { title: 'B' });
  const b = await connect('local_b', 'B');
  await b('browser_navigate', { url: `${base}/b` });
  await b('browser_tabs', { action: 'new', url: `${base}/b2` });
  await b('browser_tabs', { action: 'close', index: 1 });
  await statusInFront('another chat opens and closes tabs');

  // Chrome stops an idle extension service worker after about 30 s; the next
  // change of the front tab starts it again.
  await browser.close();
  await sleep(40000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  await b('browser_click', { element: 'open button', target: '#open' });
  await statusInFront('window.open after the extension sat idle');

  // A restarted gateway keeps it so.
  gateway.kill('SIGINT');
  await sleep(2000);
  gateway = await startGateway();
  // The browser may have been restarted with it.
  await browser.close().catch(() => {});
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const a2 = await connect('local_a', 'A');
  await a2('browser_tabs', { action: 'new', url: `${base}/after-restart` });
  await a2('browser_tabs', { action: 'close' });
  await statusInFront('after a gateway restart');
  writeChat('local_fork2', { title: 'A (fork 2)', forkedFromSessionId: 'local_a' });
  const fork2 = await connect('local_fork2', 'A (fork 2)');
  await fork2('browser_tabs', { action: 'list' });
  await statusInFront('a fork after a gateway restart');
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  await browser?.close().catch(() => {});
  gateway.kill('SIGINT');
  await sleep(1500);
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
