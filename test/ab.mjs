// A/B: runs the same agent scenarios against a gateway build and records what
// the agent gets back (console messages, page errors, permission and passkey
// notes, tool results), normalized so two builds can be compared line by line.
//
// Usage: node test/ab.mjs <path to dist/cli.js> <out.json> [browser executable]
//        node test/ab.mjs --compare <a.json> <b.json>
//
// Self-contained and headless: its own browser, gateway and scratch home.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (process.argv[2] === '--compare') {
  const a = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const b = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  let same = 0;
  const differ = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) {
      same++;
      continue;
    }
    differ.push(key);
    const la = String(a[key] ?? '<missing>').split('\n');
    const lb = String(b[key] ?? '<missing>').split('\n');
    console.log(`\n=== ${key}`);
    for (const line of la.filter(l => !lb.includes(l)))
      console.log(`- ${line}`);
    for (const line of lb.filter(l => !la.includes(l)))
      console.log(`+ ${line}`);
  }
  console.log(`\n${same} identical, ${differ.length} differ${differ.length ? `: ${differ.join(', ')}` : ''}`);
  process.exit(differ.length ? 1 : 0);
}

const cli = path.resolve(process.argv[2]);
const outFile = process.argv[3];
const executable = process.argv[4] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-ab-'));
const [cdpPort, gatewayPort] = [19531, 19532];
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, AGENTIC_PERMISSION_HOLD_MS: '4000' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pages = {
  '/console': `<!doctype html><title>console</title>
<script>
console.log('plain string');
console.log('several', 1, true, null, undefined, 'x');
console.log('object', { a: 1, b: 'two', c: [1, 2, 3], d: { e: null } });
console.log('array', [1, 'a', { b: 2 }]);
console.log('deep', { l1: { l2: { l3: { l4: 'deep' } } } });
console.log('error arg', new Error('logged error'));
console.log('function', function namedFn(a, b) { return a + b; });
console.log('map and set', new Map([['k', 1]]), new Set([1, 2]));
console.log('date', new Date(0));
console.log('symbol', Symbol('sym'), 'bigint', 10n);
console.log('element', document.documentElement);
console.log('format %s and %d and %o', 'str', 42, { o: 1 });
console.info('info message');
console.warn('warn message');
console.error('error message');
console.debug('debug message');
console.trace('trace message');
console.table([{ a: 1 }, { a: 2 }]);
console.dir({ x: 1 });
console.assert(false, 'assertion text');
console.assert(true, 'not shown');
console.count();
console.count('k');
console.group('group label');
console.log('in group');
console.groupEnd();
const getterObj = {}; Object.defineProperty(getterObj, 'g', { get() { document.title = 'GETTER RAN'; return 1; }, enumerable: true });
console.log('getter object', getterObj);
</script>
<script src="/app.js"></script>
<img src="/missing.png">
<button onclick="console.log('clicked', { n: 1 }); console.error('click error')">log on click</button>
<a href="/popup" target="_blank">popup link</a>`,
  '/app.js': `function fromFile() { console.warn('warn from app.js'); }
fromFile();
setTimeout(function later() { throw new Error('uncaught from app.js'); }, 50);`,
  '/errors': `<!doctype html><title>errors</title>
<script>
setTimeout(() => { throw new Error('uncaught error'); }, 10);
setTimeout(() => { throw 'thrown string'; }, 20);
setTimeout(() => Promise.reject(new Error('rejected error')), 30);
setTimeout(() => Promise.reject('rejected string'), 40);
setTimeout(() => { class CustomError extends Error { constructor(m) { super(m); this.name = 'CustomError'; } } throw new CustomError('custom'); }, 50);
setTimeout(() => { null.prop; }, 60);
</script>
<script>this is a syntax error</script>`,
  '/frame-host': `<!doctype html><title>frame host</title>
<script>console.log('host page log')</script>
<iframe src="http://127.0.0.1:PORT/frame"></iframe>`,
  '/frame': `<!doctype html><script>console.log('cross-site frame log', { f: 1 }); setTimeout(() => { throw new Error('frame error'); }, 10);</script>`,
  '/worker-host': `<!doctype html><title>worker host</title>
<script>
const w = new Worker('/worker.js');
w.onmessage = m => console.log('page got', m.data);
</script>`,
  '/worker.js': `console.log('worker log', { w: 1 }); console.error('worker error message'); postMessage('hi');
setTimeout(() => { throw new Error('worker uncaught'); }, 10);`,
  '/popup': `<!doctype html><title>popup</title><script>console.log('popup page log'); console.error('popup error');</script>`,
  '/permissions': `<!doctype html><title>permissions</title>
<button onclick="Notification.requestPermission().then(r => out('notif', r))">notif</button>
<button onclick="navigator.mediaDevices.getUserMedia({audio:true}).then(s => out('mic', 'granted'), e => out('mic', e.name))">mic</button>
<button onclick="queryLocalFonts().then(f => out('fonts', 'granted'), e => out('fonts', e.name))">fonts</button>
<button onclick="navigator.geolocation.getCurrentPosition(p => out('geo', 'granted'), e => out('geo', 'code ' + e.code))">geo</button>
<pre id=log></pre>
<script>function out(k, v) { document.getElementById('log').textContent += k + '=' + v + '\\n' }</script>`,
  '/passkeys': `<!doctype html><title>passkeys</title>
<button onclick="signIn()">sign in</button>
<button onclick="register()">register</button>
<pre id=log></pre>
<script>
const out = (k, v) => document.getElementById('log').textContent += k + '=' + v + '\\n';
const challenge = () => crypto.getRandomValues(new Uint8Array(32));
function signIn() {
  navigator.credentials.get({ publicKey: { challenge: challenge(), timeout: 60000, userVerification: 'preferred' } })
    .then(() => out('get', 'ok'), e => out('get', e.name));
}
function register() {
  navigator.credentials.create({ publicKey: { challenge: challenge(), timeout: 60000,
    rp: { name: 'test' }, user: { id: challenge(), name: 'u', displayName: 'u' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })
    .then(() => out('create', 'ok'), e => out('create', e.name));
}
</script>`,
};

const site = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const body = pages[p];
  res.writeHead(body ? 200 : 404, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end((body ?? 'not found').replace(/PORT/g, String(site.address().port)));
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const port = site.address().port;

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
let gatewayLog = '';
gateway.stderr.on('data', d => gatewayLog += d);
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'ab-chat', 'x-agent-title': 'AB', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'ab-test', version: '1' });
await client.connect(transport);
const raw = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');

// What differs between runs for reasons that do not matter: ports, ids,
// timings, file names with timestamps, the scratch folders.
const normalize = text => text
  .replaceAll(String(port), 'PORT')
  .replaceAll(home, 'HOME')
  .replace(/\b[0-9A-F]{8}\b/g, 'TABID')
  .replace(/\b[0-9A-F]{32}\b/g, 'TARGETID')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, 'TIME')
  .replace(/console-TIME\.log#L\d+(-L\d+)?/g, 'console-TIME.log#LINES')
  .replace(/\d+(\.\d+)? ?ms\b/g, 'N ms')
  .replace(/\/var\/folders\/[^\s)"']+|\/tmp\/[^\s)"']+/g, 'TMPPATH')
  .replace(/\[ref=[^\]]+\]/g, '[ref=R]');
const results = {};
const record = (key, text) => { results[key] = normalize(text); };
const call = async (key, name, args) => {
  const text = await raw(name, args);
  record(key, text);
  return text;
};
const consoleAll = key => call(key, 'browser_console_messages', { level: 'debug', all: true });
const ref = (snap, role, name) => snap.match(new RegExp(`${role} "${name}" \\[ref=([a-z0-9]+)\\]`))?.[1];
// A console log file the tools wrote: its content, not its name.
const consoleFile = async () => {
  const dir = fs.readdirSync(path.join(home, 'profiles', 'test', 'files')).map(d => path.join(home, 'profiles', 'test', 'files', d))[0];
  const files = dir ? fs.readdirSync(dir).filter(f => f.startsWith('console-')).sort() : [];
  return files.map(f => normalize(fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n---\n');
};

try {
  await call('console.navigate', 'browser_navigate', { url: `http://localhost:${port}/console` });
  await sleep(500);
  await consoleAll('console.all-levels');
  await call('console.default-level', 'browser_console_messages', {});
  await call('console.errors-only', 'browser_console_messages', { level: 'error' });
  const title = await raw('browser_evaluate', { function: '() => document.title' });
  record('console.getter-not-run', title.split('\n').slice(0, 2).join('\n'));
  let snap = await raw('browser_snapshot');
  await call('console.click', 'browser_click', { element: 'log on click', target: ref(snap, 'button', 'log on click') });
  await consoleAll('console.after-click');
  await call('console.popup-click', 'browser_click', { element: 'popup link', target: ref(snap, 'link', 'popup link') });
  await sleep(1000);
  const tabs = await raw('browser_tabs', { action: 'list' });
  const popupIndex = tabs.split('\n').find(l => l.includes('/popup'))?.match(/- (\d+):/)?.[1];
  if (popupIndex !== undefined) {
    await raw('browser_tabs', { action: 'select', index: Number(popupIndex) });
    await consoleAll('popup.console');
    await raw('browser_tabs', { action: 'close' });
  } else {
    record('popup.console', `no popup tab: ${tabs}`);
  }
  await call('console.evaluate-log', 'browser_evaluate', { function: '() => { console.log("from evaluate", { e: 1 }); return 1; }' });

  await call('errors.navigate', 'browser_navigate', { url: `http://localhost:${port}/errors` });
  await sleep(800);
  await consoleAll('errors.all');
  await call('errors.snapshot', 'browser_snapshot', {});

  await call('frame.navigate', 'browser_navigate', { url: `http://localhost:${port}/frame-host` });
  await sleep(800);
  await consoleAll('frame.all');

  await call('worker.navigate', 'browser_navigate', { url: `http://localhost:${port}/worker-host` });
  await sleep(800);
  await consoleAll('worker.all');

  // Permissions (as test/permissions.mjs before the stealth work).
  const notes = text => text.split('### Permission requests')[1]?.split('\n### ')[0] ?? '';
  const pageLog = async () => (await raw('browser_evaluate', { function: '() => document.getElementById("log").textContent' })).match(/### Result\n"([^"]*)"/)?.[1] ?? '';
  await raw('browser_navigate', { url: `http://localhost:${port}/permissions` });
  snap = await raw('browser_snapshot');
  const notif = await raw('browser_click', { element: 'notif', target: ref(snap, 'button', 'notif') });
  record('permissions.notif-click-note', notes(notif) || notes(await raw('browser_snapshot')));
  record('permissions.notif-waiting', String(!(await pageLog()).includes('notif=')));
  await call('permissions.deny', 'browser_permission', { decision: 'deny' });
  await sleep(500);
  record('permissions.notif-result', await pageLog());
  const mic = await raw('browser_click', { element: 'mic', target: ref(snap, 'button', 'mic') });
  let micNote = notes(mic);
  for (let i = 0; i < 20 && !/microphone/.test(micNote); i++) {
    await sleep(250);
    micNote = notes(await raw('browser_snapshot'));
  }
  record('permissions.mic-note', micNote);
  await call('permissions.allow-mic', 'browser_permission', { decision: 'allow', permissions: ['microphone'] });
  for (let i = 0; i < 25 && !/mic=/.test(await pageLog()); i++)
    await sleep(200);
  record('permissions.mic-result', await pageLog());
  const fonts = await raw('browser_click', { element: 'fonts', target: ref(snap, 'button', 'fonts') });
  await sleep(500);
  record('permissions.fonts-note', notes(fonts) || notes(await raw('browser_snapshot')));
  record('permissions.fonts-result', await pageLog());
  await call('permissions.allow-fonts', 'browser_permission', { decision: 'allow' });
  await raw('browser_click', { element: 'fonts', target: ref(snap, 'button', 'fonts') });
  await sleep(500);
  record('permissions.fonts-after-allow', await pageLog());
  const geo = await raw('browser_click', { element: 'geo', target: ref(snap, 'button', 'geo') });
  record('permissions.geo-note', notes(geo));
  await sleep(5500);
  const geoLog = await raw('browser_evaluate', { function: '() => document.getElementById("log").textContent' });
  record('permissions.geo-timeout-result', geoLog.match(/### Result\n"([^"]*)"/)?.[1] ?? '');
  record('permissions.geo-timeout-note', notes(geoLog) || notes(await raw('browser_snapshot')));
  await call('permissions.allow-ahead', 'browser_permission', { decision: 'allow', permissions: ['geolocation'] });

  // Passkeys (as test/passkeys.mjs before the stealth work).
  const pnotes = text => text.split('### Passkey requests')[1]?.split('\n### ')[0] ?? '';
  await raw('browser_navigate', { url: `http://localhost:${port}/passkeys` });
  snap = await raw('browser_snapshot');
  const signIn = await raw('browser_click', { element: 'sign in', target: ref(snap, 'button', 'sign in') });
  await sleep(300);
  record('passkeys.get-note', pnotes(signIn) || pnotes(await raw('browser_snapshot')));
  record('passkeys.get-result', await pageLog());
  const reg = await raw('browser_click', { element: 'register', target: ref(snap, 'button', 'register') });
  await sleep(300);
  record('passkeys.create-note', pnotes(reg) || pnotes(await raw('browser_snapshot')));
  record('passkeys.create-result', await pageLog());

  results['files.console-logs'] = await consoleFile();
} catch (e) {
  results.error = String(e.stack);
} finally {
  gateway.kill('SIGINT');
  await sleep(1500);
  site.close();
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  fs.writeFileSync(outFile + '.gateway.log', gatewayLog);
  console.log(`${Object.keys(results).length} results written to ${outFile}${results.error ? ` (error: ${results.error.split('\n')[0]})` : ''}`);
  process.exit(0);
}
