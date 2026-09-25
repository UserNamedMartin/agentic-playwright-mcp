// Passkey requests: in a browser nobody can see they are cancelled at once
// (not left to time out) and reported to the agent; passive autofill requests
// are left alone.
//
// Usage: node test/passkeys.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check. The other path (window in
// front, request passed on to the browser's prompt) needs a headed profile and
// someone at the screen, so it is not covered here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-passkeys-'));
const [cdpPort, gatewayPort] = [19361, 19362];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// WebAuthn needs a secure context: localhost counts.
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>passkeys</title>
<button onclick="signIn()">sign in</button>
<button onclick="register()">register</button>
<button onclick="autofill()">autofill</button>
<pre id=log></pre>
<script>
const out = (k, v) => document.getElementById('log').textContent += k + '=' + v + '\\n';
const challenge = () => crypto.getRandomValues(new Uint8Array(32));
function signIn() {
  const started = Date.now();
  navigator.credentials.get({ publicKey: { challenge: challenge(), timeout: 60000, userVerification: 'preferred' } })
    .then(() => out('get', 'ok'), e => out('get', e.name + ' after ' + (Date.now() - started) + 'ms'));
}
function register() {
  navigator.credentials.create({ publicKey: { challenge: challenge(), timeout: 60000,
    rp: { name: 'test' }, user: { id: challenge(), name: 'u', displayName: 'u' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } })
    .then(() => out('create', 'ok'), e => out('create', e.name));
}
function autofill() {
  navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: challenge() } })
    .then(() => out('autofill', 'ok'), e => out('autofill', e.name));
  out('autofill', 'started');
}
</script>`);
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
  requestInit: { headers: { 'x-agent-session-id': 'passkey-chat', 'x-agent-title': 'Passkeys', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'passkeys-test', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
let snap = '';
const click = async label => {
  const ref = snap.match(new RegExp(`button "${label}" \\[ref=([a-z0-9]+)\\]`))?.[1];
  return await call('browser_click', { element: label, target: ref });
};
const pageLog = async () => {
  const text = await call('browser_evaluate', { function: '() => document.getElementById("log").textContent' });
  return text.match(/### Result\n"([^"]*)"/)?.[1].replace(/\\n/g, ' ') ?? '';
};
const notes = text => text.split('### Passkey requests')[1]?.split('\n### ')[0] ?? '';

try {
  await call('browser_navigate', { url: `http://localhost:${site.address().port}/` });
  snap = await call('browser_snapshot');

  const signIn = await click('sign in');
  await sleep(300);
  const signInNote = notes(signIn) || notes(await call('browser_snapshot'));
  check('sign-in request reported', /asked to sign in with a passkey/.test(signInNote) && /cancelled/.test(signInNote), signInNote.split('\n')[1]);
  const log = await pageLog();
  const ms = Number(log.match(/get=NotAllowedError after (\d+)ms/)?.[1]);
  check('cancelled at once, not left to time out', ms >= 0 && ms < 2000, log);
  check('reported only once', !notes(await call('browser_snapshot')));

  const register = await click('register');
  await sleep(300);
  const registerNote = notes(register) || notes(await call('browser_snapshot'));
  check('create request reported', /asked to create a passkey/.test(registerNote), registerNote.split('\n')[1]);
  check('create cancelled', (await pageLog()).includes('create=NotAllowedError'), await pageLog());

  const autofill = await click('autofill');
  await sleep(500);
  check('autofill request left alone', !notes(autofill) && !notes(await call('browser_snapshot')));
  const afterAutofill = await pageLog();
  check('autofill request not cancelled', afterAutofill.includes('autofill=started') && !afterAutofill.includes('autofill=NotAllowedError'), afterAutofill);
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
