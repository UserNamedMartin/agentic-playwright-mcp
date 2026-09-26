// A reconnect attempt that stalls: the browser takes the connection but never
// answers one of the setup calls. The attempt must be given up and retried
// instead of leaving every session waiting forever.
//
// Usage: node test/reconnect-stall.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, site and scratch
// AGENTIC_PLAYWRIGHT_HOME. The gateway reaches the browser through a DevTools
// proxy that can cut the connection and swallow chosen calls. Takes about a
// minute. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import utils from 'playwright-core/lib/utilsBundle';

const { ws: WebSocket, wsServer: WebSocketServer } = utils;
const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-stall-'));
const [browserPort, proxyPort, gatewayPort] = [19421, 19422, 19423];
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
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>page ${req.url}</title>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));

const browser = spawn(executable, [`--remote-debugging-port=${browserPort}`, `--user-data-dir=${path.join(home, 'browser-data')}`,
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${browserPort}/json/version`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

// DevTools proxy: HTTP endpoints are passed through with the WebSocket URLs
// pointing back at the proxy; WebSocket messages are relayed one by one, so
// chosen calls can be swallowed.
let swallow = { method: '', remaining: 0 };
const swallowed = [];
const sockets = new Set();
const proxy = http.createServer(async (req, res) => {
  const upstream = await fetch(`http://127.0.0.1:${browserPort}${req.url}`, { method: req.method }).catch(() => undefined);
  if (!upstream)
    return res.writeHead(502).end();
  const body = (await upstream.text()).replaceAll(`127.0.0.1:${browserPort}`, `127.0.0.1:${proxyPort}`);
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(body);
});
const wss = new WebSocketServer({ noServer: true });
proxy.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, client => {
    const upstream = new WebSocket(`ws://127.0.0.1:${browserPort}${req.url}`);
    const early = [];
    upstream.on('open', () => early.splice(0).forEach(m => upstream.send(m)));
    client.on('message', data => {
      const text = data.toString();
      const { method } = JSON.parse(text);
      if (swallow.remaining > 0 && method === swallow.method) {
        swallow.remaining--;
        swallowed.push(method);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN)
        upstream.send(text);
      else
        early.push(text);
    });
    upstream.on('message', data => client.readyState === WebSocket.OPEN && client.send(data.toString()));
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => { sockets.delete(s); client.close(); upstream.close(); });
      s.on('error', () => {});
    }
  });
});
await new Promise(r => proxy.listen(proxyPort, '127.0.0.1', r));

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

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'chat-A', 'x-agent-title': 'chat-A', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'stall-test', version: '1' });
await client.connect(transport);
const call = async (name, args, seconds) => {
  const started = Date.now();
  const result = await Promise.race([
    client.callTool({ name, arguments: args }, undefined, { timeout: seconds * 1000 }).then(
        r => ({ text: r.content.map(c => c.text ?? '').join('\n'), isError: !!r.isError }),
        e => ({ text: `PROTOCOL ERROR ${e.message}`, isError: true })),
    sleep(seconds * 1000 + 1000).then(() => ({ text: 'NO ANSWER', isError: true })),
  ]);
  return { ...result, ms: Date.now() - started };
};

try {
  const url = `http://127.0.0.1:${site.address().port}/a`;
  await call('browser_navigate', { url }, 30);
  // The next reconnect attempt stalls on its setup; the one after works.
  swallow = { method: 'Target.setDiscoverTargets', remaining: 1 };
  for (const s of sockets)
    s.close();
  await sleep(1000);
  const answer = await call('browser_evaluate', { function: '() => location.pathname' }, 75);
  check('the stalled attempt was the one that hung', swallowed.length === 1, swallowed.join(', '));
  check('a later attempt reconnects and the call is answered', !answer.isError && answer.text.includes('/a'), `${answer.ms} ms ${answer.text}`);
  check('it was given up and retried in the log', /gave up on a stalled attempt/.test(gatewayLog), gatewayLog.split('\n').filter(l => /reconnect|attempt/i.test(l)).join(' | '));
  check('gateway still running', gateway.exitCode === null, `exit code ${gateway.exitCode}`);

  // A stall after the connection is made: the given-up attempt's connections
  // (its DevTools connection and second, idle one) must be closed too.
  swallow = { method: 'Page.addScriptToEvaluateOnNewDocument', remaining: 1 };
  swallowed.length = 0;
  for (const s of sockets)
    s.close();
  await sleep(1000);
  const again = await call('browser_evaluate', { function: '() => location.pathname' }, 75);
  check('a stall after connecting is given up too', swallowed.length === 1 && !again.isError, `${again.ms} ms ${again.text}`);
  await sleep(3000);
  const connections = sockets.size / 2;
  check('no connections left over from the given-up attempt', connections <= 2, `${connections} DevTools connections open`);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  // SIGTERM leaves the browser running (SIGINT would close it).
  gateway.kill('SIGTERM');
  await sleep(1500);
  // A gateway started on demand (activate-with) whose start stalls must be
  // replaced by the next check, not left answering every call with an error.
  try {
    swallow = { method: 'Target.setDiscoverTargets', remaining: 1 };
    const ondemandEnv = { ...env, AGENTIC_PLAYWRIGHT_HOME: path.join(home, 'ondemand') };
    const runOn = (...args) => spawn(process.execPath, [cli, ...args], { env: ondemandEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise(r => runOn('profile', 'add', 'od', '--headless', '--port', String(gatewayPort + 10), '--cdp-port', String(proxyPort)).on('exit', r));
    await new Promise(r => runOn('activate-with', 'od', 'reconnect-stall\\.mjs').on('exit', r));
    const ondemand = runOn('start', 'od');
    let odLog = '';
    ondemand.stderr.on('data', d => odLog += d);
    const odTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort + 10}/mcp`), {
      requestInit: { headers: { 'x-agent-session-id': 'od', 'x-agent-title': 'od', 'x-agent-pid': String(process.pid) } },
    });
    let answered = false;
    const started = Date.now();
    while (!answered && Date.now() - started < 60000) {
      await sleep(2000);
      try {
        const odClient = new Client({ name: 'od', version: '1' });
        await odClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort + 10}/mcp`), {
          requestInit: { headers: { 'x-agent-session-id': 'od', 'x-agent-title': 'od', 'x-agent-pid': String(process.pid) } },
        }));
        const r = await odClient.callTool({ name: 'browser_evaluate', arguments: { function: '() => 1 + 1' } }, undefined, { timeout: 10000 });
        answered = !r.isError && r.content.some(c => /### Result\n2/.test(c.text ?? ''));
        await odClient.close().catch(() => {});
      } catch {}
    }
    check('an on-demand gateway whose start stalled is replaced', answered, odLog.split('\n').slice(-12).join(' | '));
    void odTransport;
    ondemand.kill('SIGINT');
    await sleep(1500);
  } catch (e) {
    failures++;
    console.log(`FAIL ${e.stack}`);
  }
  browser.kill('SIGKILL');
  // Anything else started with this test's scratch home (a browser the
  // on-demand gateway may have launched itself).
  spawn('pkill', ['-9', '-f', home], { stdio: 'ignore' });
  await sleep(500);
  proxy.close();
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
