// Which app is in front, and bringing an app to the front, without Apple
// Events: talking to "System Events" needs an Automation permission prompt,
// which blocks forever when the gateway runs as a login service.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The link-handler applet (see urlhandler.ts). macOS only honors activation
// requests from the app that is currently active, which a background gateway
// never is; the applet becomes active while it handles a URL, so it can pass
// activation on.
const linkApplet = path.join(os.homedir(), 'Applications', 'Agentic Browser Links.app');

export function frontmostPid(): number | undefined {
  if (process.platform !== 'darwin')
    return undefined;
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const out = execFileSync('lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' });
    return Number(out.match(/=(\d+)/)?.[1]) || undefined;
  } catch {
    return undefined;
  }
}

export function activatePid(pid: number) {
  if (process.platform !== 'darwin')
    return;
  if (fs.existsSync(linkApplet)) {
    spawn('open', [`agentic-browser://raise/${pid}`], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  try {
    // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
    execFileSync('osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(3)`]);
  } catch {}
}

export type ScreenRect = { left: number; top: number; width: number; height: number };

// The main display (the one with the menu bar), in the top-left-origin
// coordinates Chrome uses for window bounds.
export function mainScreen(): ScreenRect | undefined {
  if (process.platform !== 'darwin')
    return undefined;
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('AppKit');
      const main = $.NSScreen.screens.js[0];
      const f = main.visibleFrame;
      JSON.stringify({ left: f.origin.x, top: main.frame.size.height - (f.origin.y + f.size.height), width: f.size.width, height: f.size.height });
    `], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

function appCall(pid: number, expression: string): string | undefined {
  if (process.platform !== 'darwin')
    return undefined;
  try {
    return execFileSync('osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); a ? String(${expression}) : ''`], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

// Hiding (like Cmd+H) keeps the app out of sight without a minimized-window
// thumbnail in the Dock, and unlike activation it works from the background.
export function hidePid(pid: number) {
  appCall(pid, 'a.hide');
}

export function unhidePid(pid: number) {
  appCall(pid, 'a.unhide');
}

export function isHiddenPid(pid: number): boolean {
  return appCall(pid, 'a.hidden') === 'true';
}
