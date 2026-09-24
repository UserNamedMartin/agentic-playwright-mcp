// Starts a profile's browser as a normal (headed) browser with remote
// debugging, without taking focus, and minimizes its window.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { activatePid, frontmostPid } from './macos.js';
import type { Profile } from './profiles.js';

export function cdpEndpoint(profile: Profile) {
  return `http://127.0.0.1:${profile.cdpPort}`;
}

export async function isBrowserUp(profile: Profile) {
  try {
    const res = await fetch(`${cdpEndpoint(profile)}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function browserArgs(profile: Profile) {
  return [
    `--remote-debugging-port=${profile.cdpPort}`,
    `--user-data-dir=${profile.userDataDir}`,
    // Lets the gateway load its tab-group extension over CDP.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    // Agents work in background tabs of a minimized window; keep them running at full speed.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // No window at startup: the gateway creates the first one already
    // minimized and unfocused (see Gateway._setUpHomeTab).
    ...(profile.headless ? ['--headless=new'] : ['--no-startup-window']),
  ];
}

export async function startBrowser(profile: Profile) {
  if (await isBrowserUp(profile))
    return;
  fs.mkdirSync(profile.userDataDir, { recursive: true });
  const args = browserArgs(profile);
  const appBundle = macAppBundle(profile.executablePath);
  const frontmost = appBundle && !profile.headless ? frontmostPid() : undefined;
  if (appBundle && !profile.headless) {
    // `open -g -n`: a separate instance, not activated by Launch Services.
    spawn('open', ['-g', '-n', '-a', appBundle, '--args', ...args], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn(profile.executablePath, args, { stdio: 'ignore', detached: true }).unref();
  }
  for (let i = 0; i < 100; i++) {
    if (await isBrowserUp(profile)) {
      // Chrome activates itself once its first window is up; hand focus back.
      if (frontmost)
        await restoreFrontmost(frontmost);
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Browser for profile "${profile.name}" did not open remote debugging on port ${profile.cdpPort}.`);
}

async function restoreFrontmost(pid: number) {
  for (let i = 0; i < 15; i++) {
    const current = frontmostPid();
    if (current !== undefined && current !== pid) {
      activatePid(pid);
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

function macAppBundle(executablePath: string) {
  if (process.platform !== 'darwin')
    return undefined;
  const match = executablePath.match(/^(.*\.app)\/Contents\/MacOS\//);
  return match && fs.existsSync(path.join(match[1], 'Contents', 'Info.plist')) ? match[1] : undefined;
}

// For logging in to sites that refuse a browser under remote control (Google
// sign-in, some banks): runs the profile's browser as a plain browser, without
// remote debugging, and resolves when the user quits it.
export async function runPlainBrowser(profile: Profile) {
  const appBundle = macAppBundle(profile.executablePath);
  const args = [`--user-data-dir=${profile.userDataDir}`, '--no-first-run', '--no-default-browser-check'];
  const child = appBundle
    ? spawn('open', ['-W', '-n', '-a', appBundle, '--args', ...args], { stdio: 'ignore' })
    : spawn(profile.executablePath, args, { stdio: 'ignore' });
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
}

export async function closeBrowser(profile: Profile) {
  if (!await isBrowserUp(profile))
    return;
  const { playwright } = await import('./internals.js');
  const browser = await playwright.chromium.connectOverCDP(cdpEndpoint(profile));
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.close').catch(() => {});
  for (let i = 0; i < 50 && await isBrowserUp(profile); i++)
    await new Promise(r => setTimeout(r, 200));
}
