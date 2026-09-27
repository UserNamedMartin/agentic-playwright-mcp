// Things that must not grow for as long as the gateway runs (days), and a
// long chat's transcript that must not block every session while it is read.
// The gateway keeps track of every tab (owners, the browser's target list),
// every session's proxy client and Playwright connection: all of it must be
// forgotten when the tab closes or the chat ends.
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
  const readStart = Date.now();
  const found = await index.lookup('toolu_5999');
  const readTook = Date.now() - readStart;
  worst = Math.max(worst, Date.now() - last);
  clearInterval(ticker);
  check('finds a call in a long transcript', found?.kind === 'main', JSON.stringify(found));
  // Blocking reads stall the event loop for about the whole read; reading
  // in chunks keeps every stall a small part of it (machine speed aside).
  check(`reading ${Math.round(size / 1e6)} MB does not block the process`, worst < Math.max(25, readTook / 3), `event loop stalled ${worst} ms of a ${readTook} ms read`);
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
  const http = await import('node:http');
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title>`); }).listen(0, '127.0.0.1');
  await new Promise(r => site.on('listening', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;
  const client2 = async (id, headers = {}) => {
    const c = new Client({ name: id, version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
      requestInit: { headers: { 'x-agent-session-id': id, 'x-agent-title': id, 'x-agent-pid': String(process.pid), ...headers } },
    }));
    return async (name, args = {}) => (await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content.map(x => x.text ?? '').join('\n');
  };
  const pagesNow = async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter(t => t.type === 'page');
  // Sessions' Playwright connections to the proxy (a socket file).
  const ipcConnections = () => new Promise(r => gateway._ipcServer.getConnections((e, n) => r(n)));

  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
  const A = await client2('chat-A', { 'x-agent-pid': String(sleeper.pid), 'x-agent-desktop-chat': 'local_chat_a' });
  await A('browser_navigate', { url: `${siteUrl}/a` });
  const before = await ipcConnections();
  for (let i = 0; i < 10; i++) {
    await A('browser_close');
    await A('browser_navigate', { url: `${siteUrl}/a${i}` });
  }
  await sleep(500);
  check('closing and reopening the browser does not pile up connections', await ipcConnections() <= before, `${before} -> ${await ipcConnections()}`);
  for (let i = 0; i < 10; i++) {
    await A('browser_tabs', { action: 'new' });
    await A('browser_tabs', { action: 'close' });
  }
  await sleep(1000);
  const open = new Set((await pagesNow()).map(t => t.id));
  const remembered = [...gateway.owners.keys()].filter(id => !open.has(id));
  const known = gateway.shared.pages().filter(p => !open.has(p.targetId));
  check('closed tabs are forgotten', remembered.length === 0 && known.length === 0, `${remembered.length} owned, ${known.length} known`);
  check('a chat\'s desktop title file is looked up', gateway._desktopChats.has('local_chat_a'));
  sleeper.kill();
  await sleep(200);
  await gateway._sweep();
  await sleep(300);
  check('the chat is closed once its process is gone', !gateway.sessions.has('chat-A'));
  check('its proxy client and connection go with it', !gateway.proxy._clients.has('chat-A') && await ipcConnections() === 0, `${await ipcConnections()} connections`);
  check('its tabs are closed and forgotten', ![...gateway.owners.values()].includes('chat-A') && (await pagesNow()).length === 1, (await pagesNow()).map(p => p.url).join(' '));
  check('its desktop title file is forgotten', !gateway._desktopChats.has('local_chat_a'), [...gateway._desktopChats.keys()].join(', '));

  // A tab still being opened when its chat ends is closed, not left behind.
  const S = await client2('chat-S');
  await S('browser_navigate', { url: `${siteUrl}/s` });
  const beforeEnd = (await pagesNow()).length;
  // The browser answers the creation only after the chat has ended.
  const send = gateway.shared.cdp.send.bind(gateway.shared.cdp);
  let creating;
  gateway.shared.cdp.send = (method, ...rest) => method === 'Target.createTarget'
    ? (creating = send(method, ...rest).then(async r => { await sleep(700); return r; }))
    : send(method, ...rest);
  const opening = S('browser_tabs', { action: 'new' }).catch(() => {});
  for (let i = 0; i < 100 && !creating; i++)
    await sleep(10);
  await gateway._closeSession(gateway.sessions.get('chat-S'));
  gateway.shared.cdp.send = send;
  await creating;
  await opening;
  await sleep(800);
  check('a tab opened as its chat ends is not left behind', (await pagesNow()).length <= beforeEnd - 1, `${beforeEnd} -> ${(await pagesNow()).length} pages`);

  // A call still queued when its chat ends does not start the chat again.
  const Q = await client2('chat-Q');
  await Q('browser_navigate', { url: `${siteUrl}/q` });
  const sessionQ = gateway.sessions.get('chat-Q');
  const pagesBeforeQ = (await pagesNow()).length;
  const running = Q('browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r(1), 1500))' }).catch(e => e.message);
  await sleep(200);
  const queued = Q('browser_tabs', { action: 'new' }).catch(e => e.message);
  await gateway._closeSession(sessionQ);
  await Promise.all([running, queued]);
  await sleep(800);
  check('a call queued when its chat ends leaves no tab and no backend', !sessionQ.running && (await pagesNow()).length <= pagesBeforeQ - 1, `running ${sessionQ.running}, ${pagesBeforeQ} -> ${(await pagesNow()).length} pages`);

  // A dropped connection: what the chat had running is not saved as still
  // running, and it comes back.
  const T = await client2('chat-T');
  await T('browser_navigate', { url: `${siteUrl}/t` });
  await T('browser_start_tracing');
  const sessionT = gateway.sessions.get('chat-T');
  const savedAtDrop = new Promise(resolve => {
    const detach = sessionT.detach.bind(sessionT);
    sessionT.detach = () => { detach(); resolve(sessionT.savedState()); sessionT.detach = detach; };
  });
  gateway.shared.cdp.close();
  check('a trace cut off by a drop is not saved as still running', (await savedAtDrop).tracing === false, JSON.stringify(await savedAtDrop));
  await sleep(2000);
  const back = await T('browser_evaluate', { function: '() => location.pathname' });
  check('the chat is back after the drop', back.includes('/t'), back.slice(0, 120));

  // A stuck tab creation does not hold popups' first loads for long.
  gateway.shared._creations.add(new Promise(() => {}));
  await T('browser_route', { pattern: '**/popup-target*', body: 'ROUTED' });
  const popupStart = Date.now();
  await T('browser_evaluate', { function: '() => { window.open("/popup-target"); return 1; }' });
  let popupText = '';
  for (let i = 0; i < 40 && !/ROUTED|popup-target/.test(popupText); i++) {
    await sleep(100);
    popupText = await T('browser_tabs', { action: 'list' });
  }
  await T('browser_tabs', { action: 'select', index: 1 });
  const routed = await T('browser_evaluate', { function: '() => document.body.innerText' });
  check('a stuck tab creation does not hold a popup\'s first load', routed.includes('ROUTED') && Date.now() - popupStart < 5000, `${Date.now() - popupStart} ms ${routed.slice(0, 80)}`);
  gateway.shared._creations.clear();
  site.close();
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
