// Permission requests: reported to the agent, answered with browser_permission,
// never left hanging.
//
// Usage: node test/permissions.mjs [browser executable]
//
// Self-contained and headless: its own browser (with the gateway's flags),
// gateway and scratch AGENTIC_PLAYWRIGHT_HOME. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-permissions-'));
const [cdpPort, gatewayPort] = [19351, 19352];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, AGENTIC_PERMISSION_HOLD_MS: '4000' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>permissions</title>
<button onclick="Notification.requestPermission().then(r => out('notif', r))">notif</button>
<button onclick="navigator.mediaDevices.getUserMedia({audio:true}).then(s => out('mic', 'granted'), e => out('mic', e.name))">mic</button>
<button onclick="queryLocalFonts().then(f => out('fonts', 'granted'), e => out('fonts', e.name))">fonts</button>
<button onclick="navigator.geolocation.getCurrentPosition(p => out('geo', 'granted'), e => out('geo', 'code ' + e.code))">geo</button>
<pre id=log></pre>
<script>function out(k, v) { document.getElementById('log').textContent += k + '=' + v + '\\n' }</script>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'perm-chat', 'x-agent-title': 'Permissions', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'permissions-test', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
let snap = '';
const click = async label => {
  const ref = snap.match(new RegExp(`button "${label}" \\[ref=([a-z0-9]+)\\]`))?.[1];
  return await call('browser_click', { element: label, target: ref });
};
let lastNotes = '';
const pageLog = async () => {
  const text = await call('browser_evaluate', { function: '() => document.getElementById("log").textContent' });
  lastNotes = notes(text);
  return text.match(/### Result\n"([^"]*)"/)?.[1].replace(/\\n/g, ' ') ?? '';
};
const notes = text => text.split('### Permission requests')[1]?.split('\n### ')[0] ?? '';

try {
  await call('browser_navigate', { url: `http://localhost:${site.address().port}/` });
  snap = await call('browser_snapshot');

  // Held request: the agent is told, the page waits, the answer reaches it.
  const afterClick = await click('notif');
  check('reported in the result of the click itself', /notifications/.test(notes(afterClick)));
  const seen = notes(afterClick) || notes(await call('browser_snapshot'));
  check('notification request reported', /notifications/.test(seen) && /waiting/.test(seen), seen.split('\n')[1]);
  check('page waits for the answer', !(await pageLog()).includes('notif='));
  const denied = await call('browser_permission', { decision: 'deny' });
  await sleep(500);
  check('deny reaches the waiting page', (await pageLog()).includes('notif=denied'), denied.split('\n')[1]);

  // Wait for the request to be reported before answering it, and for the page
  // to get its answer: getUserMedia can take a while in a headless browser.
  const micClick = await click('mic');
  let micNote = notes(micClick);
  for (let i = 0; i < 20 && !/microphone/.test(micNote); i++) {
    await sleep(250);
    micNote = notes(await call('browser_snapshot'));
  }
  const allowed = await call('browser_permission', { decision: 'allow', permissions: ['microphone'] });
  let mic;
  for (let i = 0; i < 25 && !mic; i++) {
    await sleep(200);
    mic = (await pageLog()).match(/mic=(\S+)/)?.[1];
  }
  check('allow reaches the waiting page', mic && mic !== 'NotAllowedError', `mic=${mic}; request: ${micNote.split('\n')[1]}; answer: ${allowed.split('\n')[1]}`);

  // Not held (needs a fresh click): refused at once, reported, works after allowing.
  const fontsClick = await click('fonts');
  check('refusal reported in the click result', /local-fonts/.test(notes(fontsClick)));
  await sleep(500);
  const fontsNote = notes(fontsClick) || notes(await call('browser_snapshot'));
  check('refused request reported', /local-fonts/.test(fontsNote) && /refused/.test(fontsNote), fontsNote.split('\n')[1]);
  const afterRefusal = await pageLog();
  check('refused request does not hang', /fonts=\w+/.test(afterRefusal), afterRefusal);
  await call('browser_permission', { decision: 'allow' });
  snap = await call('browser_snapshot');
  await click('fonts');
  await sleep(500);
  check('allowed after repeating the action', (await pageLog()).includes('fonts=granted'), await pageLog());

  // Nobody answers: refused after the hold time, reported.
  const geoClick = await click('geo');
  check('geolocation request reported in the click result', /geolocation/.test(notes(geoClick)));
  await sleep(5500);
  const geoLog = await pageLog();
  check('unanswered request is refused in time', /geo=code 1/.test(geoLog), geoLog);
  const timedOut = lastNotes || notes(await call('browser_snapshot'));
  check('agent hears it timed out', /Nobody answered/.test(timedOut), timedOut.split('\n')[1]);

  // Allowing ahead of time.
  const ahead = await call('browser_permission', { decision: 'allow', permissions: ['geolocation'] });
  check('set ahead of time for the current site', /Allowed: geolocation for http:\/\/localhost/.test(ahead), ahead.split('\n')[1]);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'test', 'sessions.json'), 'utf8'));
  check('decisions saved for reconnects', state.permissions.some(p => p.type === 'geolocation' && p.setting === 'granted'));
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
