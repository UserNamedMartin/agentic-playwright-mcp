// The gated browser (macOS): a copy of Google Chrome whose main process loads
// the show gate (native/show-gate), so pages cannot bring the out-of-sight
// browser on screen; only the gateway (for a user request) and the user can.
//
// Google Chrome's signature does not allow loading another library, so the copy
// is re-signed. No binary is changed: the gate sits in Contents/Frameworks and
// the gateway loads it with DYLD_INSERT_LIBRARIES when it starts the browser
// (Chrome's main executable has no room for another load command). Only the
// main executable's signature and the bundle seal change: it may take dyld
// environment variables, library validation is off (so the Google-signed
// framework and the gate both load), and the entitlements tied to Google's
// team are dropped. Every nested framework and helper keeps Google's
// signature. Sign with a stable identity: the profile's keychain item ("Chrome
// Safe Storage") is then granted once and stays granted across rebuilds.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, loadProfiles, updateProfile } from './profiles.js';

export const gateLibraryName = 'AgenticShowGate.dylib';
const sourceFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'native', 'show-gate', 'show_gate.m');

export const defaultGatedBrowserDir = path.join(homeDir, 'browsers');

// Entitlements that name Google's team or need Apple provisioning; a binary
// signed by anyone else that keeps them is killed at launch.
const droppedEntitlements = [
  'com.apple.application-identifier',
  'keychain-access-groups',
  'com.apple.developer.associated-domains.applinks.read-write',
  'com.apple.developer.web-browser.public-key-credential',
];
// Keystone (Google's updater) would replace the copy with a stock, ungated Chrome.
const droppedInfoKeys = ['KSProductID', 'KSUpdateURL', 'KSChannelID', 'KSVersion'];

// The gate file (a deadline in ms since epoch; see show_gate.m) and its log.
export function showGateFiles(profileName: string) {
  const dir = path.join(homeDir, 'profiles', profileName);
  return { gate: path.join(dir, 'show-gate'), log: path.join(dir, 'show-gate.log') };
}

// Environment for starting a profile's browser: loads the gate into a gated
// copy, nothing for any other browser.
export function gateEnv(profileName: string, executablePath: string): Record<string, string> | undefined {
  const lib = gateLibraryFor(executablePath);
  if (!lib)
    return undefined;
  const { gate, log } = showGateFiles(profileName);
  return { DYLD_INSERT_LIBRARIES: lib, AGENTIC_SHOW_GATE: gate, AGENTIC_SHOW_GATE_LOG: log };
}

export type GatedBuildOptions = {
  source?: string;      // the Google Chrome.app to copy
  destDir?: string;     // where the copy goes (default <home>/browsers)
  identity?: string;    // codesign identity (name or SHA-1); '-' = ad hoc
  keychain?: string;    // keychain holding the identity
  keychainPassword?: string; // its password, to unlock it without asking (it locks at every restart)
  log?: (line: string) => void;
};

// The gate library of a gated copy, or undefined for any other browser.
export function gateLibraryFor(executablePath: string) {
  const match = executablePath.match(/^(.*\.app)\/Contents\/MacOS\//);
  const lib = match && path.join(match[1], 'Contents', 'Frameworks', gateLibraryName);
  return lib && fs.existsSync(lib) ? lib : undefined;
}

// Builds a gated copy of the source browser into <destDir>/<version>/ and
// remembers how (gated-browser.json), so updateGatedBrowser can rebuild it
// after the source updates. Each build gets its own folder: a running browser
// keeps launching helpers from its own version's folder, so a build never
// replaces a copy that may be in use.
export function buildGatedBrowser(options: GatedBuildOptions = {}): { app: string; executable: string; version: string } {
  if (process.platform !== 'darwin')
    throw new Error('The gated browser is macOS only.');
  const log = options.log ?? (() => {});
  const source = options.source ?? '/Applications/Google Chrome.app';
  const destDir = options.destDir ?? defaultGatedBrowserDir;
  const identity = options.identity ?? '-';
  const info = path.join(source, 'Contents', 'Info.plist');
  const version = plistValue(info, 'CFBundleShortVersionString');
  const executableName = plistValue(info, 'CFBundleExecutable');
  const appName = path.basename(source);
  // codesign asks for a locked keychain's password in a dialog, and an update
  // runs unattended: unlock it first, or stop before anything can ask.
  if (identity !== '-' && options.keychain && !unlockKeychain(options.keychain, options.keychainPassword))
    throw new Error(`the signing keychain ${options.keychain} is locked (keychains lock at every restart): `
      + 'save its password with gated-browser build --keychain-password, or unlock it with security unlock-keychain');
  fs.mkdirSync(destDir, { recursive: true });
  let versionDir = path.join(destDir, version);
  if (fs.existsSync(versionDir) && copyInUse(versionDir))
    versionDir = path.join(destDir, `${version}-${Date.now()}`);
  const building = path.join(destDir, `.building-${path.basename(versionDir)}`);
  const tmpApp = path.join(building, appName);
  fs.rmSync(building, { recursive: true, force: true });
  fs.mkdirSync(building, { recursive: true });

  log(`copying ${source} (${version})`);
  // APFS clone: instant, no extra space until files diverge.
  run('cp', ['-cR', source, tmpApp]);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-browser-'));
  try {
    const sign = (target: string, extra: string[] = []) => run('codesign', ['--force', '--sign', identity,
      ...(options.keychain ? ['--keychain', options.keychain] : []), ...extra, target]);

    log('building the show gate');
    const lib = path.join(tmpApp, 'Contents', 'Frameworks', gateLibraryName);
    run('clang', ['-dynamiclib', '-fobjc-arc', '-O2', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0',
      '-framework', 'AppKit', '-install_name', `@executable_path/../Frameworks/${gateLibraryName}`, '-o', lib, sourceFile]);
    sign(lib, ['--timestamp=none']);

    const entitlements = path.join(work, 'entitlements.plist');
    fs.writeFileSync(entitlements, execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', source], { stdio: ['ignore', 'pipe', 'ignore'] }));
    for (const key of droppedEntitlements)
      plistBuddy(entitlements, `Delete :${key}`, true);
    plistBuddy(entitlements, 'Add :com.apple.security.cs.disable-library-validation bool true', true);
    plistBuddy(entitlements, 'Add :com.apple.security.cs.allow-dyld-environment-variables bool true', true);

    const copyInfo = path.join(tmpApp, 'Contents', 'Info.plist');
    for (const key of droppedInfoKeys)
      plistBuddy(copyInfo, `Delete :${key}`, true);

    // codesign refuses extended attributes (provenance, Finder info) in what it seals.
    run('xattr', ['-cr', tmpApp]);
    log(`signing with ${identity === '-' ? 'an ad hoc signature' : identity}`);
    // Top level only: nested frameworks and helpers keep Google's signatures.
    sign(tmpApp, ['--options', 'runtime', '--entitlements', entitlements, '--timestamp=none']);
    run('codesign', ['--verify', '--deep', '--strict', tmpApp]);

    // The first run of a newly signed app waits for the system's malware scan
    // (about 30 s), longer than the launcher waits for the browser: do it now.
    log('first run (system malware scan, about 30 s)');
    execFileSync(path.join(tmpApp, 'Contents', 'MacOS', executableName), ['--version'], { stdio: 'ignore', timeout: 300_000 });
  } catch (e) {
    fs.rmSync(building, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.renameSync(building, versionDir);
  const config: GatedConfig = {
    source, identity,
    ...(options.keychain ? { keychain: options.keychain } : {}),
    ...(options.keychainPassword ? { keychainPassword: options.keychainPassword } : {}),
  };
  fs.writeFileSync(path.join(destDir, configName), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(destDir, configName), 0o600);
  const app = path.join(versionDir, appName);
  log(`ready: ${app}`);
  return { app, executable: path.join(app, 'Contents', 'MacOS', executableName), version };
}

const configName = 'gated-browser.json';
type GatedConfig = { source: string; identity: string; keychain?: string; keychainPassword?: string };

// Whether the keychain is unlocked, after unlocking it with the password when
// one is given. Never shows UI (user interaction is off for the lookup); the
// password goes through the environment, not the command line.
export function unlockKeychain(keychain: string, password?: string): boolean {
  const script = `ObjC.import('Security');
function run(argv) {
  $.SecKeychainSetUserInteractionAllowed(false);
  const ref = Ref();
  let r = $.SecKeychainOpen(argv[0], ref);
  if (r !== 0) return 'error: cannot open the keychain (' + r + ')';
  const pw = $.NSProcessInfo.processInfo.environment.objectForKey('AGENTIC_KEYCHAIN_PASSWORD');
  if (!pw.isNil()) {
    const data = pw.dataUsingEncoding($.NSUTF8StringEncoding);
    r = $.SecKeychainUnlock(ref[0], data.length, data.bytes, true);
    if (r !== 0) return 'error: cannot unlock the keychain (' + r + (r === -25293 ? ', wrong password' : '') + ')';
  }
  const status = Ref();
  r = $.SecKeychainGetStatus(ref[0], status);
  if (r !== 0) return 'error: cannot read the keychain status (' + r + ')';
  return (status[0] & 1) ? 'unlocked' : 'locked';
}`;
  if (!fs.existsSync(keychain))
    throw new Error(`no keychain at ${keychain}`);
  const env = { ...process.env };
  delete env.AGENTIC_KEYCHAIN_PASSWORD;
  if (password)
    env.AGENTIC_KEYCHAIN_PASSWORD = password;
  const result = execFileSync('osascript', ['-l', 'JavaScript', '-e', script, keychain], { encoding: 'utf8', env, timeout: 30_000 }).trim();
  if (result.startsWith('error: '))
    throw new Error(`${keychain}: ${result.slice('error: '.length)}`);
  return result === 'unlocked';
}

// Brings the gated copies up to date with their source browser: builds a new
// copy after the source updated, points every profile that runs a gated copy
// at the newest one (they switch at their next browser start), and deletes
// copies no profile points at and no process runs. Returns what it did, or
// undefined when no gated copy was ever built here.
export function updateGatedBrowser(options: { destDir?: string; log?: (line: string) => void } = {}) {
  const destDir = options.destDir ?? defaultGatedBrowserDir;
  const log = options.log ?? (() => {});
  const configFile = path.join(destDir, configName);
  if (!fs.existsSync(configFile))
    return undefined;
  const config: GatedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return withLock(path.join(destDir, '.update-lock'), () => {
    const sourceVersion = plistValue(path.join(config.source, 'Contents', 'Info.plist'), 'CFBundleShortVersionString');
    const appName = path.basename(config.source);
    let latest = builtCopies(destDir, appName).find(c => c.version === sourceVersion);
    let built = false;
    if (!latest) {
      log(`source is ${sourceVersion}, no copy of it yet: building`);
      const result = buildGatedBrowser({ ...config, destDir, log });
      latest = { dir: path.dirname(result.app), app: result.app, version: result.version, executable: result.executable };
      built = true;
    }
    const switched: string[] = [];
    for (const profile of loadProfiles()) {
      if (profile.executablePath.startsWith(destDir + path.sep) && profile.executablePath !== latest.executable) {
        updateProfile(profile.name, { executablePath: latest.executable });
        switched.push(profile.name);
      }
    }
    if (switched.length)
      log(`profiles now on ${latest.version} (from their next browser start): ${switched.join(', ')}`);
    const wanted = new Set(loadProfiles().map(p => p.executablePath));
    const removed: string[] = [];
    for (const entry of fs.readdirSync(destDir)) {
      const dir = path.join(destDir, entry);
      if (entry.startsWith('.') || entry === configName || dir === latest.dir || !fs.statSync(dir).isDirectory())
        continue;
      // A copy at the top level (the first layout) is its own folder.
      const app = entry.endsWith('.app') ? dir : path.join(dir, appName);
      if ([...wanted].some(e => e.startsWith(app + path.sep)) || copyInUse(dir))
        continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry);
    }
    if (removed.length)
      log(`removed unused copies: ${removed.join(', ')}`);
    return { version: latest.version, executable: latest.executable, built, switched, removed };
  });
}

function builtCopies(destDir: string, appName: string) {
  const copies: { dir: string; app: string; version: string; executable: string }[] = [];
  for (const entry of fs.existsSync(destDir) ? fs.readdirSync(destDir) : []) {
    const dir = path.join(destDir, entry);
    const app = path.join(dir, appName);
    const info = path.join(app, 'Contents', 'Info.plist');
    if (entry.startsWith('.') || !fs.existsSync(info) || !fs.existsSync(path.join(app, 'Contents', 'Frameworks', gateLibraryName)))
      continue;
    const version = plistValue(info, 'CFBundleShortVersionString');
    copies.push({ dir, app, version, executable: path.join(app, 'Contents', 'MacOS', plistValue(info, 'CFBundleExecutable')) });
  }
  // Newest build first (a same-version rebuild gets a timestamped folder).
  return copies.sort((a, b) => fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs);
}

// Whether any process runs from inside this folder (a browser or its helpers).
function copyInUse(dir: string) {
  const commands = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return commands.split('\n').some(c => c.startsWith(dir + path.sep));
}

// One update at a time across processes (every profile's service runs one).
// The lock holds its owner's pid: it is stale only once that process is gone,
// however long the update takes (taking over a live one would rebuild in the
// same folder under it).
function withLock<T>(lockDir: string, fn: () => T): T {
  const pidFile = path.join(lockDir, 'pid');
  try {
    fs.mkdirSync(lockDir);
  } catch {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(pidFile, 'utf8'));
    } catch {}
    // No pid yet: just created by an update that is about to write it.
    if (pid ? processAlive(pid) : Date.now() - fs.statSync(lockDir).mtimeMs < 60_000)
      throw new Error('another update of the gated browser is running');
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(pidFile, String(process.pid));
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

// A step that hangs (a tool waiting for an answer nobody gives) fails the
// build instead of holding the update lock forever.
function run(command: string, args: string[]) {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60_000 });
  } catch (e: any) {
    throw new Error(`${command} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

function plistValue(file: string, key: string) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], { encoding: 'utf8' }).trim();
}

function plistBuddy(file: string, command: string, ignoreErrors = false) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, file], { stdio: 'ignore' });
  } catch (e) {
    if (!ignoreErrors)
      throw e;
  }
}
