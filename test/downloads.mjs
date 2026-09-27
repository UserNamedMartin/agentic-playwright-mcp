// Downloads reach the chat that started them: small files that finish at
// once, started from the main frame, a same-site iframe and a cross-site
// iframe (the way online banking pages are built). Each must end up in the
// session, and nothing may stay behind in the gateway's own download folder.
//
// Usage: node test/downloads.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, sites and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const rounds = Number(process.env.ROUNDS ?? 10);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-downloads-'));
const [browserPort, gatewayPort] = [19431, 19433];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const tmp = path.join(home, 'tmp');
fs.mkdirSync(tmp);
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, TMPDIR: tmp };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
};

// Two origins: the page on one, a cross-site iframe on the other.
let n = 0;
const handler = (req, res) => {
  if (req.url.startsWith('/file')) {
    const body = Buffer.alloc(26000, 'x');
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="statement-${++n}.csv"`, 'content-length': String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url.startsWith('/frame'))
    return res.end(`<a id=dl href="/file">download</a>`);
  const other = `http://localhost:${siteB.address().port}`;
  res.end(`<title>bank</title><a id=dl href="/file">download</a>
<iframe id=same src="/frame" width=300 height=60></iframe>
<iframe id=cross src="${other}/frame" width=300 height=60></iframe>`);
};
const siteA = http.createServer(handler).listen(0, '127.0.0.1');
const siteB = http.createServer(handler).listen(0, '127.0.0.1');
await Promise.all([siteA, siteB].map(s => new Promise(r => s.on('listening', r))));

fs.mkdirSync(path.join(home, 'browser-data', 'Default'), { recursive: true });
fs.writeFileSync(path.join(home, 'browser-data', 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: path.join(home, 'browser-downloads'), prompt_for_download: false } }));
const browser = spawn(executable, [`--remote-debugging-port=${browserPort}`, `--user-data-dir=${path.join(home, 'browser-data')}`,
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${browserPort}/json/version`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}
const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(browserPort)).on('exit', r));
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
  return (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 60000 }).then(
      r => r.content.map(c => c.text ?? '').join('\n'), e => `PROTOCOL ERROR ${e.message}`);
}

const staging = path.join(home, 'profiles', 'test', 'downloads');
try {
  // Other chats' tabs make the owner lookup slower (each tab's frames are
  // asked for in turn), as in a browser many chats use.
  const B = await chat('chat-B');
  await B('browser_navigate', { url: `http://127.0.0.1:${siteA.address().port}/other` });
  for (let i = 0; i < 15; i++)
    await B('browser_tabs', { action: 'new', url: `http://127.0.0.1:${siteA.address().port}/other${i}` });
  const A = await chat('chat-A');
  await A('browser_navigate', { url: `http://127.0.0.1:${siteA.address().port}/` });
  const where = {
    'main frame': `page.locator('#dl')`,
    'same-site iframe': `page.frameLocator('#same').locator('#dl')`,
    'cross-site iframe': `page.frameLocator('#cross').locator('#dl')`,
  };
  for (const [label, locator] of Object.entries(where)) {
    let saved = 0, stuck = 0, hung = 0;
    const details = [];
    for (let i = 0; i < rounds; i++) {
      // A fresh page each round: the first download on a page is the one
      // whose owner lookup is slowest.
      await A('browser_navigate', { url: `http://127.0.0.1:${siteA.address().port}/?${label.replace(/\W/g, '')}${i}` });
      // As an agent does it: wait for the download and save it, bounded.
      const out = await A('browser_run_code_unsafe', { code: `async (page) => {
        const wait = page.waitForEvent('download', { timeout: 10000 });
        await ${locator}.click();
        const dl = await wait;
        const saved = await Promise.race([dl.path().then(p => 'saved ' + p), page.waitForTimeout(5000).then(() => 'HUNG')]);
        return saved;
      }` });
      // (The result echoes the code, so only the part before it counts.)
      const result = out.split('### Ran Playwright code')[0];
      if (/"saved /.test(result))
        saved++;
      else if (/"HUNG"/.test(result))
        hung++;
      else
        details.push(result.slice(0, 200));
      await sleep(300);
      // (The browser also downloads its own components there for a moment.)
      const left = (fs.existsSync(staging) ? fs.readdirSync(staging) : []).filter(f => fs.statSync(path.join(staging, f)).size === 26000);
      if (process.env.VERBOSE)
        console.log(label, i, result.match(/saved \S+|HUNG|Error[^\n]*/)?.[0], 'left:', left.map(f => f.slice(0, 8) + ':' + fs.statSync(path.join(staging, f)).size).join(' '));
      stuck = Math.max(stuck, left.length);
    }
    check(`${label}: ${rounds} instant downloads reach the chat`, saved === rounds && !stuck, `saved ${saved}, hung ${hung}, left in the gateway's folder ${stuck} ${details.join(' | ')}`);
  }
} finally {
  gateway.kill('SIGTERM');
  browser.kill();
  siteA.close();
  siteB.close();
  await sleep(500);
  fs.rmSync(home, { recursive: true, force: true });
  if (process.env.VERBOSE)
    console.log(gatewayLog);
  process.exit(failures ? 1 : 0);
}
