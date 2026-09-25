// Forked chats: a chat forked in the Claude desktop app gets copies of the
// original chat's tabs (history and sessionStorage included) when it first uses
// the browser; the original chat keeps its tabs and does not take the copies.
//
// Usage: node test/forks.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway, scratch
// AGENTIC_PLAYWRIGHT_HOME, with fake desktop chat files found through
// AGENTIC_CLAUDE_APP_SUPPORT (not HOME: on macOS the browser would then look for
// its keychain there and the system would ask the user about it).
// Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-forks-'));
const appSupport = path.join(home, 'app-support');
const chatsDir = path.join(appSupport, 'Claude-test', 'claude-code-sessions', 'account', 'org');
fs.mkdirSync(chatsDir, { recursive: true });
const writeChat = (id, chat) => fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({ sessionId: id, ...chat }));
const [cdpPort, gatewayPort] = [19371, 19372];
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

const connect = async (chatId, title) => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': chatId, 'x-agent-desktop-chat': chatId, 'x-agent-title': title, 'x-agent-pid': String(process.pid) } },
  });
  const client = new Client({ name: 'forks-test', version: '1' });
  await client.connect(transport);
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
};
const tabIds = text => [...(text.split('### Tab ids')[1] ?? '').matchAll(/- \d+: ([0-9A-F]{8})/g)].map(m => m[1]);
const note = text => text.split('### Tabs of the original chat')[1]?.split('\n### ')[0] ?? '';
const evaluate = async (call, fn) => (await call('browser_evaluate', { function: fn })).match(/### Result\n([^\n]*)/)?.[1];

try {
  writeChat('local_original', { title: 'Original' });
  const original = await connect('local_original', 'Original');
  await original('browser_navigate', { url: `${base}/one` });
  await original('browser_evaluate', { function: '() => sessionStorage.setItem("step", "2")' });
  await original('browser_tabs', { action: 'new', url: `${base}/other` });
  await original('browser_tabs', { action: 'select', index: 0 });
  await original('browser_navigate', { url: `${base}/two` });
  const originalTabs = tabIds(await original('browser_tabs', { action: 'list' }));
  check('original chat has two tabs', originalTabs.length === 2, originalTabs.join(' '));

  writeChat('local_fork', { title: 'Original (fork)', forkedFromSessionId: 'local_original' });
  const fork = await connect('local_fork', 'Original (fork)');
  const first = await fork('browser_tabs', { action: 'list' });
  const forkTabs = tabIds(first);
  check('fork is told about the copies', /fork of "Original"/.test(note(first)), note(first).split('\n')[1]);
  check('fork gets copies, not the originals', forkTabs.length === 2 && forkTabs.every(id => !originalTabs.includes(id)), forkTabs.join(' '));
  check('told only once', !note(await fork('browser_tabs', { action: 'list' })));
  check('current tab copied as current', (await evaluate(fork, '() => location.pathname')) === '"/two"');
  check('history comes along', Number(await evaluate(fork, '() => history.length')) >= 2);
  check('sessionStorage comes along', (await evaluate(fork, '() => sessionStorage.getItem("step")')) === '"2"');

  await sleep(500);
  const originalAfter = tabIds(await original('browser_tabs', { action: 'list' }));
  check('original chat keeps only its own tabs', originalAfter.join(' ') === originalTabs.join(' '), originalAfter.join(' '));

  // Tabs opened later in the fork stay its own; the original is untouched.
  await fork('browser_tabs', { action: 'new', url: `${base}/fork-only` });
  check('fork opens its own tabs', tabIds(await fork('browser_tabs', { action: 'list' })).length === 3);
  check('original still has two tabs', tabIds(await original('browser_tabs', { action: 'list' })).length === 2);

  writeChat('local_plain', { title: 'Plain' });
  const plain = await connect('local_plain', 'Plain');
  const plainFirst = await plain('browser_navigate', { url: `${base}/plain` });
  check('a chat that is not a fork gets nothing', !note(plainFirst) && tabIds(await plain('browser_tabs', { action: 'list' })).length === 1);

  writeChat('local_orphan', { title: 'Orphan', forkedFromSessionId: 'local_gone' });
  const orphan = await connect('local_orphan', 'Orphan');
  // Listing tabs in a new session opens one blank tab, as in any chat.
  const orphanFirst = await orphan('browser_tabs', { action: 'list' });
  check('fork of a chat without tabs starts like any chat', !note(orphanFirst) && tabIds(orphanFirst).length <= 1 && /about:blank/.test(orphanFirst), tabIds(orphanFirst).join(' '));
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
