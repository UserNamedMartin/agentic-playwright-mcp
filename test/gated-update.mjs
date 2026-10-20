// Gated browser updates (macOS, headless, no window): after the source browser
// updates, `updateGatedBrowser` builds a copy of the new version into its own
// folder, moves profiles to it, and deletes old copies only once nothing runs
// from them (a running browser keeps launching helpers from its own copy).
//
// Usage: node test/gated-update.mjs
//
// Self-contained: a scratch AGENTIC_PLAYWRIGHT_HOME and a fake "source" (an
// APFS clone of /Applications/Google Chrome.app whose version is rewritten).
// Each build waits for the system's malware scan of the new copy (~30 s), so
// this takes a few minutes. Ad hoc signing, mock keychain: nothing on screen.
// A scratch keychain (removed from the search list again) checks that a build
// never reaches codesign with its keychain locked: codesign would ask for the
// password in a dialog.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-gatedupdate-'));
process.env.AGENTIC_PLAYWRIGHT_HOME = home;
const { buildGatedBrowser, updateGatedBrowser, unlockKeychain } = await import(path.join(root, 'dist', 'gatedbrowser.js'));
const { addProfile, getProfile } = await import(path.join(root, 'dist', 'profiles.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const source = path.join(home, 'source', 'Google Chrome.app');
fs.mkdirSync(path.dirname(source), { recursive: true });
execFileSync('cp', ['-cR', '/Applications/Google Chrome.app', source]);
const setVersion = v => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${v}`, path.join(source, 'Contents', 'Info.plist')]);
const destDir = path.join(home, 'browsers');
const copies = () => fs.readdirSync(destDir).filter(e => !e.startsWith('.') && !e.endsWith('.json')).sort();
let browser;
const searchList = execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })
  .split('\n').map(l => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
const keychain = path.join(home, 'signing.keychain-db');
const errorOf = fn => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

try {
  execFileSync('security', ['create-keychain', '-p', 'right', keychain]);
  execFileSync('security', ['list-keychains', '-d', 'user', '-s', ...searchList]);
  execFileSync('security', ['lock-keychain', keychain]);
  const kcDest = path.join(home, 'kc-browsers');
  const signed = extra => buildGatedBrowser({ source, destDir: kcDest, identity: 'No Such Identity', keychain, ...extra });
  let message = errorOf(() => signed({}));
  check('locked keychain, no password: build stops before copying', /is locked/.test(message) && !fs.existsSync(kcDest), message);
  check('the check leaves the keychain locked', unlockKeychain(keychain) === false);
  message = errorOf(() => signed({ keychainPassword: 'wrong' }));
  check('wrong password is reported', /wrong password/.test(message), message);
  message = errorOf(() => signed({ keychainPassword: 'right' }));
  check('right password unlocks it and the build goes on to sign', unlockKeychain(keychain) && /codesign failed/.test(message), message);

  setVersion('1.0.0');
  const first = buildGatedBrowser({ source, destDir });
  addProfile('test', { browser: first.executable, port: 19511, cdpPort: 19512 });
  check('first build in its own version folder', first.app === path.join(destDir, '1.0.0', 'Google Chrome.app'));

  let r = updateGatedBrowser({ destDir });
  check('no update while the source is unchanged', r && !r.built && !r.switched.length && !r.removed.length, JSON.stringify(r));

  setVersion('1.0.1');
  r = updateGatedBrowser({ destDir });
  check('source update builds the new version', r?.built && r.version === '1.0.1', JSON.stringify(r));
  check('profile moved to the new copy', getProfile('test').executablePath === r.executable);
  check('unused old copy removed', copies().join() === '1.0.1', copies().join());

  // A browser running from 1.0.1 keeps its copy through the next update.
  const profileDir = fs.mkdtempSync(path.join(home, 'profile-'));
  browser = spawn(r.executable, ['--headless=new', '--use-mock-keychain', '--no-first-run', `--user-data-dir=${profileDir}`, '--remote-debugging-port=19513', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !await fetch('http://127.0.0.1:19513/json/version').then(r => r.ok, () => false); i++)
    await sleep(500);
  setVersion('1.0.2');
  r = updateGatedBrowser({ destDir });
  check('second update builds 1.0.2', r?.built && r.version === '1.0.2', JSON.stringify(r));
  check('copy in use is kept', copies().join() === '1.0.1,1.0.2', copies().join());
  browser.kill('SIGKILL');
  browser = undefined;
  await sleep(1500);
  r = updateGatedBrowser({ destDir });
  check('kept copy removed once nothing runs from it', !r.built && copies().join() === '1.0.2', copies().join());

  // Only one update at a time.
  fs.mkdirSync(path.join(destDir, '.update-lock'));
  message = errorOf(() => updateGatedBrowser({ destDir }));
  check('a second concurrent update is refused', /another update/.test(message), message);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  browser?.kill('SIGKILL');
  try {
    execFileSync('security', ['delete-keychain', keychain], { stdio: 'ignore' });
  } catch {}
  execFileSync('security', ['list-keychains', '-d', 'user', '-s', ...searchList]);
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
