// Things that must not grow for as long as the gateway runs (days), and a
// long chat's transcript that must not block every session while it is read.
//
// Usage: node test/leaks.mjs [browser executable]
//
// Self-contained and headless: its own browser and scratch dirs. The gateway
// runs in this process so its bookkeeping can be inspected. Prints one line
// per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-leaks-'));
process.env.AGENTIC_PLAYWRIGHT_HOME = home;
process.env.AGENTIC_CLAUDE_APP_SUPPORT = path.join(home, 'claude-app');
process.env.TMPDIR = path.join(home, 'tmp');
fs.mkdirSync(process.env.TMPDIR);
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const { Gateway } = await import(path.join(dist, 'gateway.js'));
const { TranscriptIndex } = await import(path.join(dist, 'subagents.js'));
const { snippetListenerCount } = await import(path.join(dist, 'isolation.js'));
const [cdpPort, gatewayPort] = [19431, 19432];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
};

// --- A long chat's transcript.
{
  const configDir = path.join(home, 'claude');
  const project = path.join(configDir, 'projects', '-some-project');
  fs.mkdirSync(path.join(project, 'sid', 'subagents'), { recursive: true });
  const main = path.join(project, 'sid.jsonl');
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(20000) } }) + '\n';
  const toolUse = id => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } }) + '\n';
  const out = fs.openSync(main, 'w');
  fs.writeSync(out, JSON.stringify({ type: 'custom-title', customTitle: 'Long chat' }) + '\n');
  for (let i = 0; i < 6000; i++) {
    fs.writeSync(out, filler);
    fs.writeSync(out, toolUse(`toolu_${i}`));
    fs.writeSync(out, toolUse(`toolu_extra_${i}`));
    fs.writeSync(out, toolUse(`toolu_more_${i}`));
  }
  fs.closeSync(out);
  fs.writeFileSync(path.join(project, 'sid', 'subagents', 'agent-abc.jsonl'), toolUse('toolu_sub'));
  fs.writeFileSync(path.join(project, 'sid', 'subagents', 'agent-abc.meta.json'), JSON.stringify({ description: 'helper' }));
  const size = fs.statSync(main).size;

  // The event loop must keep turning while the file is read.
  let last = Date.now();
  let worst = 0;
  const ticker = setInterval(() => { worst = Math.max(worst, Date.now() - last); last = Date.now(); }, 5);
  await sleep(50);
  const index = new TranscriptIndex(configDir, 'sid');
  const found = await index.lookup('toolu_5999');
  worst = Math.max(worst, Date.now() - last);
  clearInterval(ticker);
  check('finds a call in a long transcript', found?.kind === 'main', JSON.stringify(found));
  check(`reading ${Math.round(size / 1e6)} MB does not block the process`, worst < 50, `event loop stalled ${worst} ms`);
  check('finds a subagent\'s call', (await index.lookup('toolu_sub'))?.kind === 'subagent');
  check('reads the chat\'s custom title', index.customTitle() === 'Long chat', index.customTitle());
  check('remembers a bounded number of calls', index._callers.size <= 5000, `${index._callers.size} calls kept`);
  fs.appendFileSync(main, toolUse('toolu_new'));
  check('finds a call appended later', (await index.lookup('toolu_new'))?.kind === 'main');

  // A subagent's call must not be pushed out by a busier subagent read after
  // it in the same scan (the call is routed to the main chat then).
  const sid2 = 'sid2';
  fs.mkdirSync(path.join(project, sid2, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, `${sid2}.jsonl`), '');
  fs.writeFileSync(path.join(project, sid2, 'subagents', 'agent-a.jsonl'), toolUse('pending_call'));
  fs.writeFileSync(path.join(project, sid2, 'subagents', 'agent-b.jsonl'), Array.from({ length: 6000 }, (_, i) => toolUse(`busy_${i}`)).join(''));
  const index2 = new TranscriptIndex(configDir, sid2);
  check('a pending subagent call survives a busy scan', (await index2.lookup('pending_call'))?.kind === 'subagent');
}

// --- The gateway's own bookkeeping.
const browser = spawn(executable, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(home, 'browser-data')}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}
const gateway = new Gateway({
  profile: 'test', cdpEndpoint: `http://127.0.0.1:${cdpPort}`, port: gatewayPort,
  filesDir: path.join(home, 'files'), stateFile: path.join(home, 'sessions.json'),
});
const originalError = console.error;
console.error = () => {};
try {
  await gateway.start();
  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': 'chat-A', 'x-agent-title': 'chat-A', 'x-agent-pid': String(sleeper.pid), 'x-agent-desktop-chat': 'local_chat_a' } },
  });
  const client = new Client({ name: 'leaks-test', version: '1' });
  await client.connect(transport);
  const call = async (name, args = {}) => await client.callTool({ name, arguments: args });
  await call('browser_navigate', { url: 'data:text/html,<title>a</title>' });
  const listeners = () => gateway.shared.context.listeners('close').length + gateway.shared.browser.listeners('disconnected').length;
  const listenersBefore = listeners();
  for (let i = 0; i < 10; i++) {
    await call('browser_close');
    await call('browser_navigate', { url: 'data:text/html,<title>a</title>' });
  }
  check('backends do not pile up listeners', listeners() <= listenersBefore + 2, `${listenersBefore} -> ${listeners()}`);
  for (let i = 0; i < 10; i++) {
    await call('browser_tabs', { action: 'new' });
    await call('browser_tabs', { action: 'close' });
  }
  await sleep(1000);
  const open = new Set((await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).map(t => t.id));
  const stale = [...gateway.shared._created].filter(id => !open.has(id));
  check('closed tabs are forgotten', stale.length === 0, `${stale.length} closed tab(s) still remembered`);
  check('a chat\'s desktop title file is looked up', gateway._desktopChats.has('local_chat_a'));
  sleeper.kill();
  await sleep(200);
  await gateway._sweep();
  check('the chat is closed once its process is gone', !gateway.sessions.has('chat-A'));

  // A long trace, cut into chunks by another chat starting and stopping its
  // own: stopping must not block the process (it ran out of memory at 3000
  // console lines), and each request is in the trace once.
  const http = await import('node:http');
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title>`); }).listen(0, '127.0.0.1');
  await new Promise(r => site.on('listening', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  const client2 = async id => {
    const c = new Client({ name: id, version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
      requestInit: { headers: { 'x-agent-session-id': id, 'x-agent-title': id, 'x-agent-pid': String(process.pid) } },
    }));
    return async (name, args = {}) => (await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content.map(x => x.text ?? '').join('\n');
  };
  const T = await client2('chat-T');
  const U = await client2('chat-U');
  await T('browser_navigate', { url: `${siteUrl}/t` });
  await U('browser_navigate', { url: `${siteUrl}/u` });
  await T('browser_start_tracing');
  await U('browser_start_tracing');
  await T('browser_evaluate', { function: '() => fetch("/n1").then(r => r.status)' });
  await U('browser_stop_tracing');
  await T('browser_evaluate', { function: '() => fetch("/n2").then(r => r.status)' });
  await T('browser_evaluate', { function: '() => { for (let i = 0; i < 3000; i++) console.log("line " + i + " " + "x".repeat(200)); return 1; }' });
  let tick = Date.now();
  let stall = 0;
  const ticker = setInterval(() => { stall = Math.max(stall, Date.now() - tick); tick = Date.now(); }, 5);
  const stopped = await T('browser_stop_tracing');
  stall = Math.max(stall, Date.now() - tick);
  clearInterval(ticker);
  const zip = stopped.match(/(\/\S+\.zip)/)?.[1];
  check('stopping a long trace does not block the process', !!zip && stall < 500, `event loop stalled ${stall} ms`);
  const { execFileSync } = await import('node:child_process');
  const network = zip ? execFileSync('unzip', ['-p', zip, 'trace.network'], { encoding: 'utf8' }) : '';
  const count = name => network.split('\n').filter(l => l.includes(`/${name}"`) || l.includes(`/${name}`)).length;
  check('each request is in the trace once', count('n1') === 1 && count('n2') === 1, `n1 ${count('n1')}×, n2 ${count('n2')}×`);
  // Listeners a snippet leaves: a fired once listener is forgotten, and the
  // rest go when the browser connection drops.
  await T('browser_run_code_unsafe', { code: 'async page => { page.once("console", () => {}); page.on("console", () => {}); page.context().on("request", () => {}); await page.evaluate(() => console.log("fire")); await page.waitForTimeout(300); return 1; }' });
  const sessionT = gateway.sessions.get('chat-T');
  const afterFire = snippetListenerCount(sessionT);
  check('a fired once listener is forgotten', afterFire === 2, `${afterFire} listeners kept`);
  await gateway.shared.browser.close();
  for (let i = 0; i < 50 && !gateway.shared?.browser?.isConnected(); i++)
    await sleep(200);
  await sleep(1500);
  check('snippet listeners go when the connection drops', snippetListenerCount(sessionT) === 0, `${snippetListenerCount(sessionT)} listeners kept`);

  // A trace whose start fails leaves nothing half on.
  const tracing = gateway.shared.context.tracing;
  const startChunk = tracing.startChunk.bind(tracing);
  tracing.startChunk = async () => { tracing.startChunk = startChunk; throw new Error('simulated failure'); };
  const failed = await T('browser_start_tracing');
  const leftDirs = () => fs.readdirSync(process.env.TMPDIR).filter(n => n.startsWith('agentic-trace-'));
  check('a failed trace start leaves no temp dir', /simulated failure/.test(failed) && leftDirs().length === 0, `${failed.slice(0, 80)} / ${leftDirs().join(', ')}`);
  const retry = await T('browser_start_tracing');
  check('tracing starts after a failed start', /Trace recording started/.test(retry), retry.slice(0, 120));
  await T('browser_stop_tracing');

  // Stopping must not slow down with the resources other chats loaded while
  // tracing (it was quadratic: 37 s at 500).
  await T('browser_start_tracing');
  await U('browser_evaluate', { function: '() => Promise.all(Array.from({ length: 2000 }, (_, i) => fetch("/res-" + i).then(r => r.text()))).then(a => a.length)' });
  for (let i = 0; i < 20; i++)
    await T('browser_evaluate', { function: `() => { document.body.innerHTML = "<p>${i}</p>".repeat(100000); return 1; }` });
  const startedStop = Date.now();
  const stoppedBusy = await T('browser_stop_tracing');
  const took = Date.now() - startedStop;
  check('stopping a trace is fast next to a busy chat', /\.zip/.test(stoppedBusy) && took < 5000, `${took} ms`);
  site.close();
  check('its desktop title file is forgotten', !gateway._desktopChats.has('local_chat_a'), [...gateway._desktopChats.keys()].join(', '));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  console.error = originalError;
  await gateway.stop().catch(() => {});
  browser.kill('SIGKILL');
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
