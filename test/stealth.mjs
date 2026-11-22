// What a site can tell about the browser: a page driven through the gateway
// must look to its own scripts exactly like the same page in the same browser
// with no DevTools client at all.
//
// Usage: node test/stealth.mjs [browser executable]
//
// Self-contained and headless. The probe page reports to the test's server
// (never through the tools) what bot checks look at while the page loads:
// - the DevTools console leak: a console call serializes its arguments for a
//   listening DevTools client (Runtime/Console enabled), which runs a getter
//   the page planted — in the page, a cross-site frame and a worker;
// - extra window properties and functions that are not native any more
//   (`toString`) compared with a run in a browser no one is attached to.
// The page keeps probing while an agent works with it (snapshot, click, type,
// evaluate, screenshot, console messages, a new tab from a link).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-stealth-'));
const [cdpPort, gatewayPort] = [19521, 19522];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Functions sites check for "lies"; any of them wrapped by a page script shows
// its source instead of [native code].
const probedFunctions = [
  'CredentialsContainer.prototype.get', 'CredentialsContainer.prototype.create',
  'MediaDevices.prototype.getUserMedia', 'Notification.requestPermission',
  'Geolocation.prototype.getCurrentPosition', 'Geolocation.prototype.watchPosition',
  'PushManager.prototype.subscribe', 'Navigator.prototype.requestMIDIAccess',
  'Clipboard.prototype.readText', 'Clipboard.prototype.read', 'window.queryLocalFonts',
  'window.getScreenDetails', 'Document.prototype.requestStorageAccess', 'window.open',
  'EventTarget.prototype.addEventListener', 'Function.prototype.toString', 'console.debug',
  'Permissions.prototype.query', 'HTMLElement.prototype.click',
  ...['log', 'debug', 'info', 'error', 'warn', 'dir', 'dirxml', 'table', 'trace', 'clear', 'group', 'groupCollapsed',
    'groupEnd', 'assert', 'count', 'countReset', 'time', 'timeLog', 'timeEnd'].map(m => `console.${m}`),
];

const probeScript = where => `
(() => {
  const report = data => fetch('/report', { method: 'POST', body: JSON.stringify({ where: ${JSON.stringify(where)}, ...data }) }).catch(() => {});
  // Two known ways: a stack getter on the logged error, and
  // Error.prepareStackTrace, which V8 calls when it formats the stack for a
  // DevTools client (what deviceandbrowserinfo.com checks).
  const leakSource = "(() => { let hit = false;" +
    "const e = new Error('probe');" +
    "Object.defineProperty(e, 'stack', { configurable: true, get() { hit = true; return ''; } });" +
    "console.debug(e);" +
    "const original = Error.prepareStackTrace;" +
    "Error.prepareStackTrace = function () { hit = true; return original; };" +
    "try { console.log(new Error('')); } finally { Error.prepareStackTrace = original; }" +
    "return hit; })()";
  const cdpLeak = () => (0, eval)(leakSource);
  const worker = () => new Promise(resolve => {
    const src = 'postMessage(' + leakSource + ');';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = m => { resolve(m.data); w.terminate(); };
    setTimeout(() => resolve('no answer'), 2000);
  });
  const lies = () => ${JSON.stringify(probedFunctions)}.filter(name => {
    try {
      const fn = name.split('.').reduce((o, k) => o == null ? o : o[k], window);
      return typeof fn === 'function' && !/\\{\\s*\\[native code\\]\\s*\\}$/.test(Function.prototype.toString.call(fn));
    } catch { return false; }
  });
  // Everything a lie detector compares for each function, as a string.
  const fingerprints = () => {
    const pick = name => {
      try {
        const parts = name.split('.');
        const owner = parts.slice(0, -1).reduce((o, k) => o == null ? o : o[k], window) ?? window;
        const fn = owner[parts[parts.length - 1]];
        if (typeof fn !== 'function')
          return 'none';
        const d = Object.getOwnPropertyDescriptor(owner, parts[parts.length - 1]) || {};
        let thrown = '';
        try { Function.prototype.toString.call(Object.create(fn)); } catch (e) { thrown = e.constructor.name + ':' + e.message + ':' + String(e.stack).split(location.href).join('PAGE').split(location.origin + '/plain').join('PAGE'); }
        let bad = '';
        try { fn.call(Symbol()); } catch (e) { bad = e.constructor.name + ':' + String(e.stack).split('\\n').filter(l => !l.includes('/plain') && !l.includes(location.pathname)).length; }
        // Lie-detector probes that change the function for a moment.
        let cycle = '';
        try { Object.setPrototypeOf(fn, Object.create(fn)); cycle = 'set'; String(fn); cycle += ' read'; } catch (e) { cycle += e.constructor.name + ':' + e.message; }
        finally { try { Object.setPrototypeOf(fn, Function.prototype); } catch {} }
        let ext = '';
        try { class X extends fn {} ext = 'extends ok'; } catch (e) { ext = e.constructor.name + ':' + e.message; }
        let nul = '';
        try { Object.setPrototypeOf(fn, null); nul = Function.prototype.toString.call(fn); } catch (e) { nul = e.constructor.name + ':' + e.message; }
        finally { try { Object.setPrototypeOf(fn, Function.prototype); } catch {} }
        return [cycle, ext, nul, Function.prototype.toString.call(fn), fn.name, fn.length, Object.prototype.hasOwnProperty.call(fn, 'prototype'),
          d.writable, d.enumerable, d.configurable, typeof fn.prototype, Object.getPrototypeOf(fn) === Function.prototype, thrown, bad].join('|');
      } catch (e) { return 'error ' + e.message; }
    };
    const out = {};
    for (const name of ${JSON.stringify(probedFunctions)}.concat(['Function.prototype.toString']))
      out[name] = pick(name);
    out['toString.toString'] = Function.prototype.toString.call(Function.prototype.toString.toString);
    return out;
  };
  // Another realm's toString applied to this realm's functions shows a Proxy
  // (it cannot see this realm's masking).
  const crossRealm = () => {
    try {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      document.documentElement.appendChild(f);
      const ts = f.contentWindow.Function.prototype.toString;
      const out = ['console.log', 'Function.prototype.toString', 'MediaDevices.prototype.getUserMedia', 'CredentialsContainer.prototype.get', 'Notification.requestPermission']
        .map(name => { try { return ts.call(name.split('.').reduce((o, k) => o[k], window)); } catch (e) { return 'error ' + e.message; } }).join(' || ');
      f.remove();
      return out;
    } catch (e) { return 'error ' + e.message; }
  };
  // Logged values: a getter and a Proxy trap that must never run.
  const traps = () => {
    let hits = [];
    const getter = {}; Object.defineProperty(getter, 'g', { enumerable: true, get() { hits.push('getter'); return 1; } });
    const proxy = new Proxy({ p: 1 }, { ownKeys(t) { hits.push('ownKeys'); return Reflect.ownKeys(t); }, get(t, k) { hits.push('get ' + String(k)); return t[k]; },
      getOwnPropertyDescriptor(t, k) { hits.push('gopd'); return Reflect.getOwnPropertyDescriptor(t, k); }, getPrototypeOf(t) { hits.push('proto'); return Object.prototype; } });
    console.log(getter, proxy);
    console.error(proxy);
    return new Promise(r => setTimeout(() => r(hits.join(',')), 300));
  };
  let ever = false;
  const probe = async phase => {
    const leak = cdpLeak();
    ever = ever || leak;
    report({ phase, leak, worker: phase === 'load' || phase === 'late' ? await worker() : undefined,
      globals: Object.getOwnPropertyNames(window), lies: lies(), fingerprints: fingerprints(), crossRealm: crossRealm(), traps: await traps() });
  };
  probe('load');
  let n = 0;
  const timer = setInterval(() => {
    const leak = cdpLeak();
    if (leak && !ever) { ever = true; report({ phase: 'interval ' + n, leak: true }); }
    if (++n === 150) { clearInterval(timer); probe('late'); }
  }, 100);
})();`;

// The generated hook scripts must at least parse: a hook that never runs
// is invisible too, and every check below would pass.
{
  const hooks = await import(path.join(path.dirname(cli), 'pagehooks.js'));
  const names = hooks.hookNames('test');
  for (const [name, source] of Object.entries({ main: hooks.mainWorldHook(names), worker: hooks.workerHook(names), isolated: hooks.isolatedChannel(names) })) {
    let error = '';
    try { new Function(source); } catch (e) { error = e.message; }
    check(`${name} hook script parses`, !error, error);
  }
}

const reports = [];
const page = where => `<!doctype html><title>probe ${where}</title>
<script>${probeScript(where)}</script>
<input aria-label=name><button onclick="this.textContent='clicked'">press</button>
<a href="/popup" target="_blank">other tab</a>
${where === 'main' ? `<iframe src="http://127.0.0.1:${'PORT'}/frame"></iframe>` : ''}`;
const site = http.createServer((req, res) => {
  if (req.url === '/report') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { reports.push(JSON.parse(body)); res.end(); });
    return;
  }
  const where = { '/': 'main', '/frame': 'frame', '/popup': 'popup', '/plain': 'plain', '/plain-frame': 'plain-frame' }[req.url.split('?')[0]];
  res.writeHead(where ? 200 : 404, { 'content-type': 'text/html' });
  let html = where ? page(where) : '';
  if (where === 'plain')
    html = html.replace('</title>', '</title>').replace(/<\/a>/, `</a><iframe src="http://127.0.0.1:${site.address().port}/plain-frame"></iframe>`);
  res.end(html.replace('PORT', String(site.address().port)));
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const port = site.address().port;

// Baseline: the same browser, headless, with no DevTools client attached.
const baselineDir = fs.mkdtempSync(path.join(home, 'baseline-'));
const baseline = spawn(executable, ['--headless=new', `--user-data-dir=${baselineDir}`, '--no-first-run',
  '--no-default-browser-check', '--disable-features=MacAppCodeSignClone', `http://localhost:${port}/plain`], { stdio: 'ignore' });
const until = async (pred, ms) => {
  for (let i = 0; i < ms / 100 && !pred(); i++)
    await sleep(100);
  return pred();
};
await until(() => reports.some(r => r.where === 'plain' && r.phase === 'late') && reports.some(r => r.where === 'plain-frame' && r.phase === 'late'), 30000);
baseline.kill('SIGKILL');
const plain = where => reports.find(r => r.where === where && r.phase === 'load');
check('baseline reported', plain('plain') && plain('plain-frame'));
check('baseline itself shows no DevTools leak', plain('plain') && !plain('plain').leak && plain('plain').worker === false,
  JSON.stringify({ leak: plain('plain')?.leak, worker: plain('plain')?.worker }));

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'stealth-chat', 'x-agent-title': 'Stealth', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'stealth-test', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
const ref = (snap, role, name) => snap.match(new RegExp(`${role} "${name}" \\[ref=([a-z0-9]+)\\]`))?.[1];

const compare = (where, plainWhere) => {
  const got = reports.filter(r => r.where === where);
  const load = got.find(r => r.phase === 'load');
  const late = got.find(r => r.phase === 'late');
  if (!load || !late)
    return check(`${where}: page reported while loading and after the agent's calls`, false, `${got.length} reports`);
  check(`${where}: no DevTools console leak, at load or while the agent works`, !got.some(r => r.leak),
    got.filter(r => r.leak).map(r => r.phase).join(', '));
  check(`${where}: no DevTools console leak in a worker`, load.worker === false && late.worker === false,
    `load=${load.worker} late=${late.worker}`);
  const base = new Set(plain(plainWhere).globals);
  const extra = [...new Set([...load.globals, ...late.globals])].filter(g => !base.has(g));
  check(`${where}: no window properties a plain browser does not have`, !extra.length, extra.join(', '));
  const lies = [...new Set([...load.lies, ...late.lies])];
  check(`${where}: built-in functions still native`, !lies.length, lies.join(', '));
  const base2 = plain(plainWhere);
  for (const report of [load, late]) {
    const differ = Object.keys(base2.fingerprints).filter(k => base2.fingerprints[k] !== report.fingerprints[k]);
    check(`${where} (${report.phase}): every function looks as in a plain browser (source, name, length, prototype, descriptor, errors)`, !differ.length,
      differ.map(k => {
        const a = report.fingerprints[k].split('|'), b = base2.fingerprints[k].split('|');
        return `${k}: ` + a.map((v, i) => v === b[i] ? null : `[${i}] ${JSON.stringify(v)} vs ${JSON.stringify(b[i])}`).filter(Boolean).join(', ');
      }).join('; ').slice(0, 8000));
    check(`${where} (${report.phase}): another realm's toString sees the same functions`, report.crossRealm === base2.crossRealm,
      `${report.crossRealm} vs ${base2.crossRealm}`.slice(0, 400));
    check(`${where} (${report.phase}): logging runs no getter and no Proxy trap of the page`, report.traps === base2.traps, `${report.traps} vs ${base2.traps}`);
  }
};

try {
  await call('browser_navigate', { url: `http://localhost:${port}/` });
  let snap = await call('browser_snapshot');
  await call('browser_type', { element: 'name', target: ref(snap, 'textbox', 'name'), text: 'hello' });
  await call('browser_click', { element: 'press', target: ref(snap, 'button', 'press') });
  await call('browser_evaluate', { function: '() => document.title' });
  await call('browser_take_screenshot', {});
  const logged = await call('browser_console_messages', { level: 'debug', all: true });
  check('the page hook is at work: the page\'s console reaches the agent', /\[LOG\] getter object|\[ERROR\]/.test(logged) || /Total messages: [1-9]/.test(logged), logged.split('\n').slice(0, 3).join(' '));
  snap = await call('browser_snapshot');
  await call('browser_click', { element: 'other tab', target: ref(snap, 'link', 'other tab') });
  await until(() => ['main', 'frame', 'popup'].every(w => reports.some(r => r.where === w && r.phase === 'late')), 30000);
  compare('main', 'plain');
  compare('frame', 'plain-frame');
  compare('popup', 'plain');
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
