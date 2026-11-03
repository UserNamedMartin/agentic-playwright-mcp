// A browser the launcher starts leaves no Chrome code-sign clone behind when
// it is killed. Chrome on macOS clones its whole app bundle into
// $TMPDIR/../X/<bundle id>.code_sign_clone/ at every start and removes the
// clone only on a clean exit, so every killed test browser left ~2 GB there.
//
// Usage: node test/code-sign-clone.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check. macOS only.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-clone-'));
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [gatewayPort, cdpPort] = [19471, 19472];
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
};

if (process.platform !== 'darwin') {
  console.log('skip: code-sign clones are macOS only');
  process.exit(0);
}

const cloneRoot = path.join(os.tmpdir(), '..', 'X');
const clones = () => {
  try {
    return fs.readdirSync(cloneRoot).filter(d => d.endsWith('.code_sign_clone'))
        .flatMap(d => fs.readdirSync(path.join(cloneRoot, d)).map(c => path.join(cloneRoot, d, c)));
  } catch {
    return [];
  }
};

const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
const before = new Set(clones());
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
let up = false;
for (let i = 0; i < 150 && !up; i++) {
  up = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.ok, () => false);
  if (!up)
    await sleep(200);
}
check('browser started', up);
// Chrome makes its clone within a second or two of starting.
await sleep(3000);

const browserPid = Number(execFileSync('lsof', ['-nP', `-iTCP:${cdpPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]);
// Killed first: stopping the gateway would close it cleanly.
process.kill(browserPid, 'SIGKILL');
await sleep(1000);
gateway.kill('SIGINT');
await sleep(1000);

const left = clones().filter(c => !before.has(c));
// Another Chrome started on the machine meanwhile would show up here too, so
// a failure names the folders and leaves them for a person to check.
check('a killed browser leaves no code-sign clone', left.length === 0, left.join(', '));
fs.rmSync(home, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
