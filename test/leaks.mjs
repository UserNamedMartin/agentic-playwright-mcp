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
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const { Gateway } = await import(path.join(dist, 'gateway.js'));
const { TranscriptIndex } = await import(path.join(dist, 'subagents.js'));
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
