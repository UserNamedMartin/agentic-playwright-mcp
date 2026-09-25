// Tabs survive a dropped browser connection and a gateway restart; tab group
// titles follow the chat title.
//
// Usage: node test/reconnect.mjs [browser executable]
//
// Runs everything itself, headless, in a scratch AGENTIC_PLAYWRIGHT_HOME: a
// browser, a TCP proxy in front of its DevTools port (dropping the proxy's
// connections is what a Mac does to DevTools clients when its display turns
// off), and the gateway on the proxy. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from 'playwright-core';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-reconnect-'));
const [browserPort, proxyPort, gatewayPort] = [19341, 19342, 19343];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Browser, headless, on its own port.
const browserProc = spawn(executable, [
  `--remote-debugging-port=${browserPort}`, `--user-data-dir=${path.join(home, 'browser-data')}`,
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
], { stdio: 'ignore' });

// Proxy that can drop every connection on demand.
const sockets = new Set();
const proxy = net.createServer(client => {
  const upstream = net.connect(browserPort, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  for (const s of [client, upstream]) {
    sockets.add(s);
    s.on('close', () => {
      sockets.delete(s);
      client.destroy();
      upstream.destroy();
    });
    s.on('error', () => {});
  }
});
await new Promise(r => proxy.listen(proxyPort, '127.0.0.1', r));
const dropConnections = () => sockets.forEach(s => s.destroy());

// A test site: a page with a target=_blank link.
const site = (await import('node:http')).createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>${req.url}</title><a id=out href="/opened-from-link" target=_blank>open</a><p>${req.url}</p>`);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}`;

// Fake Claude Code config dir with a transcript, for /rename titles.
const configDir = path.join(home, 'claude');
const claudeSession = 'cli-session-1';
const transcript = path.join(configDir, 'projects', 'proj', `${claudeSession}.jsonl`);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.writeFileSync(transcript, '');

for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${browserPort}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false))
    break;
  await sleep(200);
}
const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(proxyPort)).on('exit', r));
let gateway = run('start', 'test');
const gatewayUrl = `http://127.0.0.1:${gatewayPort}/mcp`;
const waitForGateway = async () => {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
      return;
    await sleep(200);
  }
  throw new Error('gateway did not start');
};
await waitForGateway();

const connect = async (id, title, extra = {}) => {
  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), {
    requestInit: { headers: { 'x-agent-session-id': id, 'x-agent-title': encodeURIComponent(title), 'x-agent-pid': String(process.pid), ...extra } },
  });
  const client = new Client({ name: 'reconnect-test', version: '1' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result.content.map(c => c.text ?? '').join('\n');
  };
  return { client, call };
};
const tabIds = text => [...text.matchAll(/^- \d+: ([0-9A-F]{8})/gm)].map(m => m[1]);

const groupTitles = async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`);
  try {
    for (const worker of browser.contexts()[0].serviceWorkers()) {
      if (await worker.evaluate(() => typeof self.apmPing === 'function').catch(() => false))
        return await worker.evaluate(async () => (await chrome.tabGroups.query({})).map(g => g.title).sort());
    }
    return [];
  } finally {
    await browser.close();
  }
};

try {
  // A chat connects but does not use the browser: nothing is created.
  const idle = await connect('idle-chat', 'Idle chat');
  await idle.client.listTools();
  const filesRoot = path.join(home, 'profiles', 'test', 'files');
  check('connecting creates no files folder', !fs.existsSync(filesRoot) || fs.readdirSync(filesRoot).length === 0);

  const a = await connect('chat-a', 'cwd-name', {
    'x-agent-claude-session': claudeSession,
    'x-agent-config-dir': encodeURIComponent(configDir),
  });
  await a.call('browser_navigate', { url: `${siteUrl}/a1` });
  await a.call('browser_tabs', { action: 'new' });
  await a.call('browser_navigate', { url: `${siteUrl}/a2` });
  const before = tabIds(await a.call('browser_tabs', { action: 'list' }));
  check('two tabs before the drop', before.length === 2, before.join(' '));
  check('group titled from the client', (await groupTitles()).includes('cwd-name'));

  // /rename in the CLI renames the group.
  fs.appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed chat', sessionId: claudeSession }) + '\n');
  await a.call('browser_snapshot');
  await sleep(16_000);
  check('group follows /rename', (await groupTitles()).includes('Renamed chat'), (await groupTitles()).join(', '));

  // Same title in another chat: numbered.
  const b = await connect('chat-b', 'Renamed chat');
  await b.call('browser_navigate', { url: `${siteUrl}/b1` });
  await sleep(500);
  const titles = await groupTitles();
  check('same titles are told apart', titles.includes('Renamed chat') && titles.includes('Renamed chat (2)'), titles.join(', '));

  // Drop the DevTools connection; the browser lives on.
  dropConnections();
  await sleep(3000);
  const after = tabIds(await a.call('browser_tabs', { action: 'list' }));
  check('same MCP session keeps working after the drop', after.length > 0);
  check('tabs kept after the drop', after.join() === before.join(), after.join(' '));
  const snap = await a.call('browser_snapshot');
  check('current tab kept', /Page URL: \S+\/a2\b/.test(snap), snap.match(/Page URL: \S+/)?.[0]);
  const ref = snap.match(/link "open" \[ref=(e\d+)\]/)?.[1];
  check('link found in snapshot', !!ref);
  if (ref)
    await a.call('browser_click', { element: 'open link', target: ref });
  await sleep(1500);
  const withLink = await a.call('browser_tabs', { action: 'list' });
  check('target=_blank link still opens a background tab', withLink.includes('opened-from-link'), `${tabIds(withLink).length} tabs`);
  const bTabs = tabIds(await b.call('browser_tabs', { action: 'list' }));
  check('other chat keeps its tab', bTabs.length === 1);
  check('groups kept after the drop', (await groupTitles()).includes('Renamed chat (2)'));

  // A drop in the middle of calls: a read-only one is repeated by the gateway,
  // an action reports what happened instead of a raw error.
  const waiting = a.call('browser_wait_for', { time: 2 });
  const evaluating = b.call('browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r("done"), 2000))' });
  await sleep(500);
  dropConnections();
  const waited = await waiting;
  check('read-only call cut off by a drop is repeated', !waited.includes('Error'), waited.split('\n')[1]);
  const evaluated = await evaluating;
  check('action cut off by a drop says so', evaluated.includes('connection to the browser dropped'), evaluated.split('\n')[1]?.slice(0, 80));

  // Restart the gateway (service restart = SIGTERM): the browser and tabs stay.
  const beforeRestart = tabIds(withLink);
  const stateFile = path.join(home, 'profiles', 'test', 'sessions.json');
  gateway.kill('SIGTERM');
  await new Promise(r => gateway.on('exit', r));
  if (process.env.DEBUG_STATE)
    console.log((await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json()).map(t => `${t.type} ${t.id} ${t.url}`).join('\n'));
  gateway = run('start', 'test');
  await waitForGateway();
  const a2 = await connect('chat-a', 'cwd-name', {
    'x-agent-claude-session': claudeSession,
    'x-agent-config-dir': encodeURIComponent(configDir),
  });
  const afterRestart = tabIds(await a2.call('browser_tabs', { action: 'list' }));
  check('tabs kept after a gateway restart', afterRestart.join() === beforeRestart.join(), afterRestart.join(' '));
  check('groups kept after a gateway restart', (await groupTitles()).includes('Renamed chat'));
  const shot = await a2.call('browser_take_screenshot', { filename: 'after-restart.png' });
  const folders = fs.readdirSync(filesRoot);
  const chatA = folders.find(name => name === 'chat-a');
  check('same files folder after restart', folders.length === 2 && !!chatA && fs.existsSync(path.join(filesRoot, chatA, 'after-restart.png')), folders.join(', '));

  await a2.call('browser_tabs', { action: 'close', index: 0 });
  await sleep(1500);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const saved = state.sessions.find(s => s.info.id === 'chat-a');
  check('closed tab removed from saved state', saved?.targets.length === afterRestart.length - 1, `${saved?.targets.length}`);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  gateway.kill('SIGINT');
  await sleep(1000);
  browserProc.kill();
  proxy.close();
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
