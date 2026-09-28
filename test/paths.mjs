// Saved files are named by absolute path in results, and nothing else in a
// result is rewritten: the code Playwright ran, evaluate results and page
// text keep a file's name as it was, even when that file exists.
//
// Usage: node test/paths.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, site and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-paths-'));
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const [cdpPort, gatewayPort] = [19471, 19472];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 240)}` : ''}`);
};

const site = http.createServer((req, res) => {
  if (req.url === '/report.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
    return res.end('a,b\n1,2\n');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>paths</title><a id=dl href="/report.csv">report.csv</a> <a href="/other">shot.png</a> <p id=name>notes.txt</p>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const url = `http://127.0.0.1:${site.address().port}/`;

const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'ignore'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
for (let i = 0; i < 150; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'paths-test-1234', 'x-agent-title': 'paths', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'paths', version: '1' });
const call = async (tool, args = {}) => {
  const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
  return r.content.map(c => c.text ?? '').join('\n');
};
const link = (text, title) => text.match(new RegExp(`^- \\[${title}[^\\]]*\\]\\((.+)\\)$`, 'm'))?.[1];
const absoluteFile = p => !!p && path.isAbsolute(p) && fs.existsSync(p);

try {
  await client.connect(transport);
  await call('browser_navigate', { url });

  // What Playwright saved is named by absolute path.
  const named = await call('browser_take_screenshot', { scale: 'css', filename: 'shot.png' });
  const shot = link(named, 'Screenshot');
  check('a named screenshot is linked by absolute path', absoluteFile(shot), named);
  const filesDir = path.dirname(shot ?? '');
  for (const name of ['notes.txt', 'report.csv'])
    fs.writeFileSync(path.join(filesDir, name), 'x');
  const unnamed = await call('browser_take_screenshot', { scale: 'css' });
  check('an unnamed screenshot is linked by absolute path', absoluteFile(link(unnamed, 'Screenshot')), unnamed);
  const snap = await call('browser_snapshot', { filename: 'snap.md' });
  check('a saved snapshot is linked by absolute path', absoluteFile(link(snap, 'Snapshot')), snap);
  const saved = await call('browser_evaluate', { function: '() => 1', filename: 'result.json' });
  check('a saved evaluate result is linked by absolute path', absoluteFile(link(saved, 'Evaluation result')), saved);

  let events = await call('browser_click', { target: '#dl', element: 'download link' });
  for (let i = 0; i < 20 && !/Downloaded file/.test(events); i++) {
    await sleep(500);
    events += await call('browser_tabs', { action: 'list' });
  }
  const downloaded = events.match(/^- Downloaded file .* to "(.+)"$/m)?.[1];
  check('a download is named by absolute path', absoluteFile(downloaded), events.match(/.*Download.*/g)?.join(' | ') ?? events);

  // Everything else keeps a file's name, although the file exists.
  const code = await call('browser_run_code_unsafe', { code: `async (page) => { const name = 'shot.png'; return name; }` });
  const echo = code.split('### Ran Playwright code')[1] ?? '';
  check('the code Playwright ran is shown as it was written', echo.includes(`const name = 'shot.png'`) && !echo.includes(filesDir), echo);
  check('a run_code result keeps a file name', code.includes('"shot.png"') && !code.split('### Ran')[0].includes(filesDir), code);
  const evaluated = await call('browser_evaluate', { function: `() => document.getElementById('name').textContent` });
  check('an evaluate result keeps a file name', evaluated.includes('"notes.txt"') && !evaluated.includes(filesDir), evaluated);
  const page = await call('browser_snapshot');
  const yaml = page.split('### Snapshot')[1] ?? page;
  check('page text in a snapshot keeps file names', /shot\.png/.test(yaml) && /report\.csv/.test(yaml) && !yaml.includes(filesDir), yaml);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  await client.close().catch(() => {});
  gateway.kill('SIGINT');
  await sleep(1500);
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
