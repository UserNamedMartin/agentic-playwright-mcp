// What one session's trouble does to the others and to the gateway: a failed
// download, a page stuck in an endless loop, a call given up while the page
// still has something to report, and the browser connection dropping while a
// download runs.
//
// Usage: node test/robustness.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, site and scratch
// AGENTIC_PLAYWRIGHT_HOME. The gateway reaches the browser through a TCP proxy
// here, so the test can cut the connection. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-robust-'));
const [browserPort, proxyPort, gatewayPort] = [19411, 19412, 19413];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
};

const site = http.createServer((req, res) => {
  if (req.url === '/broken-download') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"', 'content-length': '10000000' });
    res.write(Buffer.alloc(1000));
    setTimeout(() => res.destroy(), 300);
    return;
  }
  if (req.url === '/slow-download') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="y.bin"', 'content-length': '100000000' });
    const timer = setInterval(() => res.write(Buffer.alloc(1000)), 200);
    res.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>page ${req.url}</title><a id=broken href="/broken-download">a</a><a id=slow href="/slow-download">b</a>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const url = p => `http://127.0.0.1:${site.address().port}/${p}`;

// The browser is started by the test, so the proxy can sit in front of it.
const browser = spawn(executable, [`--remote-debugging-port=${browserPort}`, `--user-data-dir=${path.join(home, 'browser-data')}`,
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'], { stdio: 'ignore' });
const sockets = new Set();
const proxy = net.createServer(client => {
  const upstream = net.connect(browserPort, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  for (const s of [client, upstream]) {
    sockets.add(s);
    s.on('close', () => { sockets.delete(s); client.destroy(); upstream.destroy(); });
    s.on('error', () => {});
  }
}).listen(proxyPort, '127.0.0.1');
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${browserPort}/json/version`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(proxyPort)).on('exit', r));
const gateway = run('start', 'test');
let gatewayLog = '';
gateway.stderr.on('data', d => gatewayLog += d);
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
  // Raced against a deadline: a stuck session never answers.
  return async (name, args = {}, seconds = 30) => {
    const started = Date.now();
    const result = await Promise.race([
      client.callTool({ name, arguments: args }, undefined, { timeout: seconds * 1000 }).then(
          r => ({ text: r.content.map(c => c.text ?? '').join('\n'), isError: !!r.isError }),
          e => ({ text: `PROTOCOL ERROR ${e.message}`, isError: true })),
      sleep(seconds * 1000 + 1000).then(() => ({ text: 'NO ANSWER', isError: true })),
    ]);
    return { ...result, ms: Date.now() - started };
  };
}

try {
  const A = await chat('chat-A');
  const B = await chat('chat-B');
  await B('browser_navigate', { url: url('b') });

  // A download that fails in A's tab is A's business.
  await A('browser_navigate', { url: url('a') });
  await A('browser_evaluate', { function: '() => { document.getElementById("broken").click(); return 1; }' });
  await sleep(2500);
  const b = await B('browser_evaluate', { function: '() => 1 + 1' });
  check('another chat\'s failed download is not an error in B', !b.isError && /### Result\n2/.test(b.text), b.text);

  // A call given up while the page still has something to tell (a permission
  // request) must leave that for the next result.
  const trigger = '() => new Promise(r => { setTimeout(() => navigator.clipboard.readText().catch(() => {}), 2500); setTimeout(() => r("late"), 4000); })';
  const givenUp = await A('browser_evaluate', { function: trigger, timeout: 1.5 });
  check('slow call is given up', /did not finish within 1.5 s/.test(givenUp.text), givenUp.text);
  await sleep(4500);
  const next = await A('browser_evaluate', { function: '() => 1' });
  check('the next result still gets the permission request', next.text.includes('Permission requests'), next.text);

  // A page stuck in an endless loop.
  await A('browser_navigate', { url: url('loop') });
  const loop = await A('browser_evaluate', { function: '() => { while (true) {} }', timeout: 3 });
  check('stuck page: call given up, told which tab', /did not finish within 3 s/.test(loop.text) && loop.text.includes('/loop'), loop.text);
  const list = await A('browser_tabs', { action: 'list' }, 15);
  check('stuck page: tab list still answers', !list.isError && list.ms < 8000, `${list.ms} ms ${list.text}`);
  check('stuck page: tab list says it is not responding', /not responding/.test(list.text), list.text);
  const fresh = await A('browser_tabs', { action: 'new', url: url('fresh') }, 15);
  check('stuck page: a new tab works', !fresh.isError && fresh.ms < 8000, `${fresh.ms} ms ${fresh.text}`);
  const close = await A('browser_tabs', { action: 'close', index: 0 }, 15);
  check('stuck page: closing it works', !close.isError, close.text);
  const after = await A('browser_evaluate', { function: '() => location.pathname' }, 15);
  check('stuck page: session back to normal', !after.isError && after.text.includes('/fresh') && after.ms < 3000, `${after.ms} ms ${after.text}`);
  const other = await B('browser_evaluate', { function: '() => 2' });
  check('stuck page: B unaffected', !other.isError && other.ms < 3000, `${other.ms} ms`);

  // The browser connection drops while a download runs.
  await A('browser_navigate', { url: url('a2') });
  await A('browser_evaluate', { function: '() => { document.getElementById("slow").click(); return 1; }' });
  await sleep(2000);
  sockets.forEach(s => s.destroy());
  await sleep(6000);
  check('gateway survives a dropped connection during a download', gateway.exitCode === null, `exit code ${gateway.exitCode}`);
  const back = await A('browser_evaluate', { function: '() => location.pathname' }, 20);
  check('A works again after the reconnect', !back.isError && back.text.includes('/a2'), back.text);
  check('unhandled rejection logged, not fatal', !/triggerUncaughtException/.test(gatewayLog));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  // End the running download first and kill the browser outright: quitting
  // Chrome with a download in progress makes macOS ask the user on screen.
  site.closeAllConnections();
  gateway.kill('SIGINT');
  await sleep(1500);
  browser.kill('SIGKILL');
  proxy.close();
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
