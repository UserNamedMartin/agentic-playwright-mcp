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
import { homeDir } from './profiles.js';

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
  log?: (line: string) => void;
};

// The gate library of a gated copy, or undefined for any other browser.
export function gateLibraryFor(executablePath: string) {
  const match = executablePath.match(/^(.*\.app)\/Contents\/MacOS\//);
  const lib = match && path.join(match[1], 'Contents', 'Frameworks', gateLibraryName);
  return lib && fs.existsSync(lib) ? lib : undefined;
}

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
  const finalApp = path.join(destDir, appName);
  const tmpApp = path.join(destDir, `.building-${appName}`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.rmSync(tmpApp, { recursive: true, force: true });

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
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Swap in the new copy; a running browser keeps the files it has open.
  const old = path.join(destDir, `.old-${appName}`);
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(finalApp))
    fs.renameSync(finalApp, old);
  fs.renameSync(tmpApp, finalApp);
  fs.rmSync(old, { recursive: true, force: true });
  log(`ready: ${finalApp}`);
  return { app: finalApp, executable: path.join(finalApp, 'Contents', 'MacOS', executableName), version };
}

function run(command: string, args: string[]) {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
