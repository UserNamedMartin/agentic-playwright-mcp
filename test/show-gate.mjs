// The show gate (macOS, headed): with the browser out of sight, pages that try
// to bring it on screen must not manage to; only the gateway's focusTab (a
// user request) may show it.
// - window.open of a blob: document (a register's "open extract" button)
// - window.open of a popup window (width/height features)
// - a form with target=_blank
// - a link with target=_blank rel=opener (left to Chrome on purpose)
// - window.focus() from a background tab
// Then browser_show_tab must still show the window, un-minimized, and keep it
// in view, and so must a click on the Dock icon (a reopen event).
//
// Usage: node test/show-gate.mjs [--ungated]
//   --ungated runs the same steps on stock Google Chrome, without the gate:
//   it is expected to FAIL (that is the bug the gate fixes).
//
// Self-contained: builds an ad hoc signed gated copy into a scratch
// AGENTIC_PLAYWRIGHT_HOME, its own headed browser and gateway. The first launch
// of a freshly signed copy waits ~30 s for the system's malware scan. A
// browser window shows at the end (browser_show_tab), and without the gate
// every step flashes: run it only with the go-ahead of whoever sits at the
// screen.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ungated = process.argv.includes('--ungated');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-showgate-'));
process.env.AGENTIC_PLAYWRIGHT_HOME = home;
const { frontmostPid, isHiddenPid } = await import(path.join(root, 'dist', 'macos.js'));
const { buildGatedBrowser, showGateFiles } = await import(path.join(root, 'dist', 'gatedbrowser.js'));
const { CdpConnection } = await import(path.join(root, 'dist', 'cdp.js'));
const [cdpPort, gatewayPort] = [19501, 19502];
const cli = path.join(root, 'dist', 'cli.js');
// Mock keychain: an ad hoc signed copy would ask the user for keychain access.
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, AGENTIC_CLAUDE_APP_SUPPORT: path.join(home, 'app-support'), AGENTIC_MOCK_KEYCHAIN: '1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = `<title>gate test</title>
<button id=blob onclick="window.open(URL.createObjectURL(new Blob(['%PDF-1.4 test'], {type: 'application/pdf'})))">blob</button>
<button id=popup onclick="window.open('/popup', 'p', 'width=400,height=300')">popup</button>
<form id=form action=/form target=_blank><button id=submit>form</button></form>
<a id=opener href=/opener target=_blank rel=opener>opener</a>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/' ? page : `<title>${req.url}</title>${req.url}`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const base = `http://127.0.0.1:${site.address().port}`;

let executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!ungated) {
  console.log('building the gated copy (ad hoc) ...');
  executable = buildGatedBrowser({ destDir: path.join(home, 'browsers') }).executable;
  // The first run of a freshly signed copy waits for the system's malware
  // scan, longer than the launcher waits for the browser: run it once first.
  console.log('first run (malware scan) ...');
  execFileSync(executable, ['--version'], { stdio: 'ignore', timeout: 180_000 });
}
const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
// The gateway logs to stderr in the foreground; keep it for the focus guard check.
let gatewayLog = '';
const gateway = spawn(process.execPath, [cli, 'start', 'test'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
gateway.stderr.on('data', d => gatewayLog += d);
for (let i = 0; i < 300; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'gate-chat', 'x-agent-title': 'Gate test', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'show-gate-test', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');

const browserPid = () => {
  try {
    return Number(execFileSync('pgrep', ['-f', `remote-debugging-port=${cdpPort}`], { encoding: 'utf8' }).split('\n')[0]) || undefined;
  } catch {
    return undefined;
  }
};
// Watches whether the browser is ever on screen (unhidden) or frontmost.
const shown = [];
let watching = true;
const watch = (async () => {
  while (watching) {
    const pid = browserPid();
    if (pid) {
      const front = frontmostPid() === pid;
      const visible = !isHiddenPid(pid);
      if (front || visible)
        shown.push({ at: Date.now(), front, visible });
    }
    await sleep(40);
  }
})();

try {
  await call('browser_navigate', { url: base });
  await sleep(1500);
  // Right after launch the app is briefly not hidden (with no window on
  // screen) until the gateway hides it; count from here on.
  shown.length = 0;
  const pid = browserPid();
  check('out of sight after start', isHiddenPid(pid) && frontmostPid() !== pid);
  for (const [name, target] of [['window.open blob', '#blob'], ['window.open popup', '#popup'], ['form target=_blank', '#submit'], ['link rel=opener', '#opener']]) {
    const from = shown.length;
    await call('browser_click', { target, element: name });
    await sleep(2000);
    check(`${name}: browser stays out of sight`, shown.length === from, `${shown.length - from} sample(s) on screen`);
  }
  // window.focus() from a tab that is not in front.
  const created = await call('browser_tabs', { action: 'new', url: `${base}/focus` });
  const focusTab = created.match(/- \d+: (\w+) \(current\)/)?.[1];
  await call('browser_tabs', { action: 'select', index: 0 });
  const from = shown.length;
  await call('browser_evaluate', { function: '() => window.focus()', tab: focusTab });
  await sleep(2000);
  check('window.focus(): browser stays out of sight', shown.length === from, `${shown.length - from} sample(s) on screen`);

  const log = gatewayLog.match(/focus guard: .*/g) ?? [];
  check('focus guard had nothing to undo', log.length === 0, log.slice(0, 3).join(' | '));
  if (!ungated) {
    const gateLog = fs.existsSync(showGateFiles('test').log) ? fs.readFileSync(showGateFiles('test').log, 'utf8').trim().split('\n') : [];
    console.log(`     gate blocked ${gateLog.length} call(s): ${[...new Set(gateLog.map(l => l.replace(/^\d+ blocked | \(#\d+\)$/g, '')))].join(', ')}`);
  }

  // A user request still shows the window, and it stays: the window must
  // really come out of the Dock (a window the gate never let be ordered in
  // stays minimized, and the focus guard then hides the app again after 3 s).
  const shownBefore = shown.length;
  const logBefore = gatewayLog.length;
  await call('browser_show_tab', {});
  await sleep(4500);
  check('browser_show_tab shows the window', shown.length > shownBefore, `${shown.length - shownBefore} sample(s) on screen`);
  const cdp = await CdpConnection.connect(await CdpConnection.browserUrl(`http://127.0.0.1:${cdpPort}`));
  const { targetInfos } = await cdp.send('Target.getTargets');
  const states = [];
  for (const t of targetInfos.filter(t => t.type === 'page' && t.url.startsWith(base)))
    states.push((await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId })).bounds.windowState);
  cdp.close();
  check('browser_show_tab: the tab\'s window is un-minimized', states.length > 0 && states.every(s => s === 'normal'), states.join(', '));
  const pidAfter = browserPid();
  check('browser_show_tab: still in view 4.5 s later', !isHiddenPid(pidAfter) && frontmostPid() === pidAfter);
  const hidden = gatewayLog.slice(logBefore).match(/window minimized; hiding the browser too|did not come into view.*/g) ?? [];
  check('browser_show_tab: nothing hid it again', hidden.length === 0, hidden.join(' | '));

  // The user clicks the browser's Dock icon while it is out of sight: macOS
  // sends the app a reopen event, as `open -a <bundle>` does for a running
  // app. Chrome must bring back the minimized window with the tabs, not open
  // an empty one, and the focus guard must leave it on screen. Only with our
  // own gated copy: on stock Chrome `open -a` would reach the user's browser.
  if (!ungated) {
    const windows = async () => {
      const conn = await CdpConnection.connect(await CdpConnection.browserUrl(`http://127.0.0.1:${cdpPort}`));
      const { targetInfos } = await conn.send('Target.getTargets');
      const byWindow = new Map();
      for (const t of targetInfos.filter(t => t.type === 'page')) {
        const { windowId, bounds } = await conn.send('Browser.getWindowForTarget', { targetId: t.targetId });
        byWindow.set(windowId, { state: bounds.windowState, home: byWindow.get(windowId)?.home || t.url.startsWith(`http://127.0.0.1:${gatewayPort}`) });
      }
      conn.close();
      return byWindow;
    };
    // Back out of sight the way a user does it: minimize; the guard hides the app.
    const conn = await CdpConnection.connect(await CdpConnection.browserUrl(`http://127.0.0.1:${cdpPort}`));
    const { targetInfos: pages } = await conn.send('Target.getTargets');
    const tab = pages.find(t => t.type === 'page' && t.url.startsWith(base));
    const { windowId } = await conn.send('Browser.getWindowForTarget', { targetId: tab.targetId });
    await conn.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    conn.close();
    let pid = browserPid();
    for (let i = 0; i < 50 && !isHiddenPid(pid); i++)
      await sleep(100);
    await sleep(500);
    check('Dock: out of sight before the click', isHiddenPid(pid) && frontmostPid() !== pid);
    const before = await windows();
    const logAtClick = gatewayLog.length;
    execFileSync('open', ['-a', executable.replace(/\/Contents\/MacOS\/.*$/, '')]);
    await sleep(4500);
    const after = await windows();
    pid = browserPid();
    const home = [...after.values()].find(w => w.home);
    check('Dock: the window with the tabs comes back', home?.state === 'normal', [...after].map(([id, w]) => `${id}:${w.state}${w.home ? '(home)' : ''}`).join(' '));
    check('Dock: no new empty window', after.size === before.size, `${before.size} window(s) before, ${after.size} after`);
    check('Dock: still in view 4.5 s later', !isHiddenPid(pid) && frontmostPid() === pid);
    const hiddenAfterClick = gatewayLog.slice(logAtClick).match(/window minimized; hiding the browser too|focus guard: .*/g) ?? [];
    check('Dock: nothing hid it again', hiddenAfterClick.length === 0, hiddenAfterClick.join(' | '));
  }
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  watching = false;
  await watch;
  await client.close().catch(() => {});
  gateway.kill('SIGINT');
  await sleep(1500);
  const pid = browserPid();
  if (pid)
    process.kill(pid, 'SIGKILL');
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
