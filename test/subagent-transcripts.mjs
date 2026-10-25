// Subagents are found in the chat's current transcripts, wherever they are:
// - a new desktop chat connects before the app has written its CLI session id
//   (no x-agent-claude-session header); the id appears in the chat file later;
// - the app continues a chat under a new CLI session id while the headers keep
//   the old one;
// - a client connected without x-agent-config-dir (older helper): the config
//   dir comes from the agent process's environment.
// In each case a subagent's call must get its own session (own tabs), not the
// chat's.
//
// Usage: node test/subagent-transcripts.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, scratch
// AGENTIC_PLAYWRIGHT_HOME, fake desktop chat files through
// AGENTIC_CLAUDE_APP_SUPPORT and fake transcripts in a scratch config dir.
// Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [cdpPort, gatewayPort] = [19491, 19492];
const self = new URL(import.meta.url).pathname;

// Child mode: a client process whose environment carries CLAUDE_CONFIG_DIR,
// as the Claude Code process does. It connects without x-agent-config-dir.
if (process.argv[2] === 'client') {
  const [, , , chatId, configDir, sid] = process.argv;
  const call = await connect({ 'x-agent-session-id': chatId, 'x-agent-desktop-chat': chatId, 'x-agent-title': chatId, 'x-agent-pid': String(process.pid) });
  const files = transcripts(configDir, sid, ['c1']);
  await call(files.main, 'browser_navigate', { url: `${process.env.SITE}/?who=main` });
  const sub = await who(call, files.c1, 'c1');
  console.log(JSON.stringify(sub));
  process.exit(0);
}

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-subtranscripts-'));
const appSupport = path.join(home, 'app-support');
const configDir = path.join(home, 'claude-config');
const chatsDir = path.join(appSupport, 'Claude-test', 'claude-code-sessions', 'account', 'org');
fs.mkdirSync(chatsDir, { recursive: true });
const writeChat = (id, chat) => fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({ sessionId: id, title: id, ...chat }));
const cli = path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
// A short cap for the call whose line never comes (30 s otherwise).
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, AGENTIC_CLAUDE_APP_SUPPORT: appSupport, AGENTIC_TRANSCRIPT_WAIT_MS: '4000' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>${req.url}</title><p>${req.url}</p>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const base = `http://127.0.0.1:${site.address().port}`;

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

// A subagent has its own session when it sees only the tab it opened.
const own = (result, tag) => result.ok && result.tabs.length === 1 && result.tabs[0].includes(`who=${tag}`);

try {
  // 1. New desktop chat: no CLI session id yet when it connects.
  writeChat('local_new', {});
  const newChat = await connect({ 'x-agent-session-id': 'local_new', 'x-agent-desktop-chat': 'local_new', 'x-agent-title': 'New',
    'x-agent-pid': String(process.pid), 'x-agent-config-dir': encodeURIComponent(configDir) });
  let files = transcripts(configDir, 'sid-one', ['a1', 'a2']);
  // The chat's first call: the app has not written the session id yet.
  await newChat(files.main, 'browser_navigate', { url: `${base}/?who=main` });
  writeChat('local_new', { cliSessionId: 'sid-one' });
  const a1 = await who(newChat, files.a1, 'a1');
  check('subagent of a chat whose session id came later gets its own tabs', own(a1, 'a1'), a1.tabs.join(' '));
  const mainTabs = tabUrls(await newChat(files.main, 'browser_tabs', { action: 'list' }));
  check('the chat keeps only its own tab', mainTabs.length === 1 && mainTabs[0].includes('who=main'), mainTabs.join(' '));

  // 2. The app continues the chat under a new session id.
  files = transcripts(configDir, 'sid-two', ['b1']);
  writeChat('local_new', { cliSessionId: 'sid-two' });
  const b1 = await who(newChat, files.b1, 'b1');
  check('subagent after the session id changed gets its own tabs', own(b1, 'b1'), b1.tabs.join(' '));

  // 2b. Headers carry an old id, the chat file the current one.
  writeChat('local_moved', { cliSessionId: 'sid-moved-new' });
  const moved = await connect({ 'x-agent-session-id': 'local_moved', 'x-agent-desktop-chat': 'local_moved', 'x-agent-title': 'Moved',
    'x-agent-pid': String(process.pid), 'x-agent-config-dir': encodeURIComponent(configDir), 'x-agent-claude-session': 'sid-moved-old' });
  transcripts(configDir, 'sid-moved-old', []);
  const movedFiles = transcripts(configDir, 'sid-moved-new', ['m1']);
  await moved(movedFiles.main, 'browser_navigate', { url: `${base}/?who=main` });
  const m1 = await who(moved, movedFiles.m1, 'm1');
  check('the chat file\'s session id wins over a stale header', own(m1, 'm1'), m1.tabs.join(' '));

  // 2c. Claude Code writes the tool_use to disk after the call has started
  // (measured: 0.1-1 s later, more under load). The call must still go to the
  // subagent that made it, not to the chat.
  writeChat('local_late', { cliSessionId: 'sid-late' });
  const late = await connect({ 'x-agent-session-id': 'local_late', 'x-agent-desktop-chat': 'local_late', 'x-agent-title': 'Late',
    'x-agent-pid': String(process.pid), 'x-agent-config-dir': encodeURIComponent(configDir) });
  const lateFiles = transcripts(configDir, 'sid-late', ['l1', 'l2']);
  await late(lateFiles.main, 'browser_navigate', { url: `${base}/?who=main` });
  for (const [tag, delay] of [['l1', 900], ['l2', 2500]]) {
    const r = await who((file, name, args) => late(file, name, args, delay), lateFiles[tag], tag);
    // A misrouted call lands in the chat's tab, where `own` alone would pass.
    const lateMain = tabUrls(await late(lateFiles.main, 'browser_tabs', { action: 'list' }, 900));
    check(`subagent call written to the transcript ${delay} ms late gets its own tabs`,
      own(r, tag) && lateMain.length === 1 && lateMain[0].includes('who=main'), `${tag}: ${r.tabs.join(' ')}; chat: ${lateMain.join(' ')}`);
  }

  // 2d. Several subagents and the chat at once, every line late: each keeps
  // its own tab (the live case had 3-5 subagents in parallel).
  const parFiles = transcripts(configDir, 'sid-late', ['p1', 'p2', 'p3']);
  const lateCall = (file, name, args) => late(file, name, args, 300 + Math.floor(Math.random() * 1200));
  const par = await Promise.all(['p1', 'p2', 'p3'].map(tag => who(lateCall, parFiles[tag], tag)));
  const parMain = tabUrls(await lateCall(lateFiles.main, 'browser_tabs', { action: 'list' }));
  check('parallel subagents with late transcripts each keep their own tabs',
    par.every(r => own(r, r.tag)) && parMain.length === 1 && parMain[0].includes('who=main'),
    par.map(r => `${r.tag}: ${r.tabs.join(' ')}`).join('; ') + `; chat: ${parMain.join(' ')}`);

  // 2e. A subagent that wrote nothing for a long time (a long shell command)
  // is still a subagent: no "recently alive" guess may send it to the chat.
  // Its own chat, so the gateway has never seen the subagent's file fresh.
  writeChat('local_idle', { cliSessionId: 'sid-idle' });
  const idleChat = await connect({ 'x-agent-session-id': 'local_idle', 'x-agent-desktop-chat': 'local_idle', 'x-agent-title': 'Idle',
    'x-agent-pid': String(process.pid), 'x-agent-config-dir': encodeURIComponent(configDir) });
  const idleFiles = transcripts(configDir, 'sid-idle', ['i1']);
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(idleFiles.i1, old, old);
  await idleChat(idleFiles.main, 'browser_navigate', { url: `${base}/?who=main` });
  const idle = await who((file, name, args) => idleChat(file, name, args, 1200), idleFiles.i1, 'i1');
  const idleMain = tabUrls(await idleChat(idleFiles.main, 'browser_tabs', { action: 'list' }));
  check('a subagent idle for 30 min, its line 1.2 s late, gets its own tabs',
    own(idle, 'i1') && idleMain.length === 1 && idleMain[0].includes('who=main'), `i1: ${idle.tabs.join(' ')}; chat: ${idleMain.join(' ')}`);

  // 2f. A call whose line never appears is refused, not run in the chat.
  const ghost = await late(path.join(path.dirname(lateFiles.main), 'nowhere.jsonl'), 'browser_navigate', { url: `${base}/?who=ghost` });
  const ghostMain = tabUrls(await late(lateFiles.main, 'browser_tabs', { action: 'list' }));
  check('a call nobody\'s transcript names is refused', /could not tell which agent/.test(ghost), ghost.split('\n')[0]);
  check('... and the chat\'s tab is untouched', ghostMain.length === 1 && ghostMain[0].includes('who=main'), ghostMain.join(' '));

  // 3. No config dir in the headers: taken from the agent's environment.
  writeChat('local_envdir', { cliSessionId: 'sid-env' });
  const child = spawn(process.execPath, [self, 'client', 'local_envdir', configDir, 'sid-env'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, SITE: base }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', d => out += d);
  await new Promise(r => child.on('exit', r));
  const c1 = JSON.parse(out.trim().split('\n').pop() || '{}');
  check('config dir from the agent\'s environment', own({ ok: c1.ok, tabs: c1.tabs ?? [] }, 'c1'), (c1.tabs ?? []).join(' '));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  gateway.kill('SIGINT');
  await sleep(1500);
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

async function connect(headers) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: 'subagent-transcripts-test', version: '1' });
  await client.connect(transport);
  // Appends the tool_use to the caller's transcript, `lateMs` after the call
  // started (Claude Code's own write can come after the call).
  return async (file, name, args = {}, lateMs = 0) => {
    const id = `toolu_${Math.random().toString(36).slice(2)}`;
    const write = () => fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__browser__${name}`, input: {} }] } }) + '\n');
    if (lateMs)
      setTimeout(write, lateMs);
    else
      write();
    const res = await client.callTool({ name, arguments: args, _meta: { 'claudecode/toolUseId': id } });
    return res.content.map(c => c.text ?? '').join('\n');
  };
}

// <configDir>/projects/<project>/<sid>.jsonl and <sid>/subagents/agent-<id>.jsonl
function transcripts(configDir, sid, agents) {
  const dir = path.join(configDir, 'projects', '-tmp-project');
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
  const files = { main: path.join(dir, `${sid}.jsonl`) };
  fs.appendFileSync(files.main, '');
  for (const id of agents) {
    files[id] = path.join(dir, sid, 'subagents', `agent-${id}.jsonl`);
    fs.appendFileSync(files[id], '');
    fs.writeFileSync(path.join(dir, sid, 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `agent ${id}` }));
  }
  return files;
}

function tabUrls(text) {
  return text.split('### Result')[1]?.split('\n### ')[0].split('\n').filter(l => /^- \d+: .*\]\(/.test(l)).map(l => l.match(/\]\((.*)\)$/)?.[1]) ?? [];
}

async function who(call, file, tag) {
  await call(file, 'browser_navigate', { url: `${process.env.SITE ?? base}/?who=${tag}` });
  const href = await call(file, 'browser_evaluate', { function: '() => location.href' });
  return { tag, ok: href.includes(`who=${tag}`), tabs: tabUrls(await call(file, 'browser_tabs', { action: 'list' })) };
}
