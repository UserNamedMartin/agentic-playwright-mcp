// Checks that need a headed browser (macOS): nothing here may show the hidden
// browser or take focus, except the one step that shows it on purpose.
// - copying a forked chat's tabs (chrome.tabs.duplicate) keeps the browser
//   hidden, minimized and in the background;
// - passkey requests are cancelled while the browser is hidden and passed on to
//   the browser once its window is in front, where the passkey prompt then
//   waits (nothing is answered; the prompt goes away with the test browser).
//
// Usage: node test/headed.mjs [browser executable]
//
// Self-contained: its own headed browser, gateway and scratch
// AGENTIC_PLAYWRIGHT_HOME. It shows a browser window for a moment near the end:
// run it only with the go-ahead of whoever sits at the screen.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { isHiddenPid } = await import(path.join(root, 'dist', 'macos.js'));
const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-headed-'));
const appSupport = path.join(home, 'app-support');
const chatsDir = path.join(appSupport, 'Claude-test', 'claude-code-sessions', 'account', 'org');
fs.mkdirSync(chatsDir, { recursive: true });
const writeChat = (id, chat) => fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({ sessionId: id, ...chat }));
const [cdpPort, gatewayPort] = [19381, 19382];
const cli = path.join(root, 'dist', 'cli.js');
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
  res.end(`<title>${req.url}</title>
<button onclick="register()">register</button><pre id=log></pre>
<script>
const out = v => document.getElementById('log').textContent += v + '\\n';
const bytes = () => crypto.getRandomValues(new Uint8Array(32));
function register() {
  navigator.credentials.create({ publicKey: { challenge: bytes(), timeout: 20000, rp: { name: 'test' },
    user: { id: bytes(), name: 'u', displayName: 'u' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })
    .then(() => out('create=ok'), e => out('create=' + e.name));
}
</script>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const base = `http://localhost:${site.address().port}`;

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
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
  const client = new Client({ name: 'headed-test', version: '1' });
  await client.connect(transport);
  return async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
};
const evaluate = async (call, fn) => (await call('browser_evaluate', { function: fn })).match(/### Result\n([^\n]*)/)?.[1];
const passkeyNote = text => text.split('### Passkey requests')[1]?.split('\n### ')[0] ?? '';

// A second DevTools client, for the window state and the browser's pid.
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const cdp = await browser.newBrowserCDPSession();
const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
const pid = processInfo.find(p => p.type === 'browser').id;
const frontApp = () => {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    return execFileSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' }).match(/=\s*(\d+)/)?.[1];
  } catch {
    return undefined;
  }
};
const windowStates = async () => {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const states = new Set();
  for (const t of targetInfos.filter(t => t.type === 'page')) {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }).catch(() => ({}));
    if (windowId !== undefined)
      states.add((await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState);
  }
  return [...states].join(',');
};
// Samples what the user could see while `action` runs, and for a while after.
const watch = async (action, afterMs = 3000) => {
  const seen = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      seen.push({ front: frontApp() === String(pid), hidden: isHiddenPid(pid), windows: await windowStates().catch(() => '?') });
      await sleep(50);
    }
  })();
  const result = await action();
  await sleep(afterMs);
  running = false;
  await sampler;
  return { result, seen };
};

try {
  await sleep(2000);
  check('browser starts hidden', isHiddenPid(pid) && frontApp() !== String(pid));

  writeChat('local_original', { title: 'Original' });
  const original = await connect('local_original', 'Original');
  await original('browser_navigate', { url: `${base}/one` });
  await original('browser_evaluate', { function: '() => sessionStorage.setItem("step", "2")' });
  await original('browser_navigate', { url: `${base}/two` });

  // Forked chat: the copies must not show the browser.
  writeChat('local_fork', { title: 'Original (fork)', forkedFromSessionId: 'local_original' });
  const fork = await connect('local_fork', 'Original (fork)');
  const { result: first, seen } = await watch(() => fork('browser_tabs', { action: 'list' }));
  check('fork got the copy', /Tabs of the original chat/.test(first));
  check('copy made by duplicating (history and sessionStorage)', Number(await evaluate(fork, '() => history.length')) >= 2 &&
      (await evaluate(fork, '() => sessionStorage.getItem("step")')) === '"2"');
  const shown = seen.filter(s => !s.hidden || s.front || !/^minimized$/.test(s.windows));
  check('browser stayed hidden, minimized and in the background while copying', !shown.length,
      `${seen.length} samples${shown.length ? `, e.g. ${JSON.stringify(shown[0])}` : ''}`);

  // Passkeys. Hidden: cancelled at once. Window in front: passed on, and the
  // browser's (on macOS the system's) passkey prompt waits for the user, so the
  // page gets no answer. SCREENSHOT=<file.png> saves the screen at that moment.
  const snapRef = async () => (await original('browser_snapshot')).match(/button "register"[^\n]*?\[ref=([a-z0-9]+)\]/)?.[1];
  const pageLog = () => evaluate(original, '() => document.getElementById("log").textContent');
  const hiddenClick = await original('browser_click', { element: 'register', target: await snapRef() });
  await sleep(500);
  check('hidden: passkey request cancelled at once', /cancelled/.test(passkeyNote(hiddenClick)) &&
      (await pageLog()) === '"create=NotAllowedError\\n"', await pageLog());

  await original('browser_show_tab');
  await sleep(1500);
  const visible = !isHiddenPid(pid) && /normal|maximized|fullscreen/.test(await windowStates());
  check('browser_show_tab shows the window', visible);
  const shownClick = await original('browser_click', { element: 'register', target: await snapRef() });
  await sleep(3000);
  if (process.env.SCREENSHOT) {
    execFileSync('screencapture', ['-x', process.env.SCREENSHOT]);
    console.log(`  screen saved to ${process.env.SCREENSHOT}`);
  }
  check('window in front: passkey request passed on, the prompt waits for the user',
      /window is in front/.test(passkeyNote(shownClick)) && (await pageLog()) === '"create=NotAllowedError\\n"', await pageLog());
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  await browser.close().catch(() => {});
  gateway.kill('SIGINT');
  await sleep(2000);
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
