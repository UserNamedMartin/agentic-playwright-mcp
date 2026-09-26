// agentic-browser://<profile>/tab/<targetId> links. Chat apps open them with the
// OS instead of the everyday browser, so no helper tab flashes up. macOS only:
// a tiny background applet registered for the scheme forwards the URL to the
// profile's gateway.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getProfile, homeDir } from './profiles.js';
import { linkToken, readLinkSecret } from './linktoken.js';

export const linkScheme = 'agentic-browser';
const appPath = path.join(os.homedir(), 'Applications', 'Agentic Browser Links.app');

export function tabLink(profile: string, targetId: string) {
  return `${linkScheme}://${profile}/tab/${targetId}`;
}

export async function openLink(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== `${linkScheme}:`)
    throw new Error(`Not an ${linkScheme}:// link: ${url}`);
  const profile = getProfile(parsed.hostname);
  const [, kind, id] = parsed.pathname.split('/');
  const secret = readLinkSecret(profile.name) ?? '';
  const signed = kind === 'tab' && id ? `target:${id}` : 'home';
  const query = (kind === 'tab' && id ? `target=${encodeURIComponent(id)}` : 'home=1') + `&t=${linkToken(secret, signed)}&go=1`;
  const res = await fetch(`http://127.0.0.1:${profile.port}/focus?${query}`);
  if (!res.ok)
    throw new Error(`Gateway for "${profile.name}" answered ${res.status}`);
}

// Rewriting an app bundle trips macOS App Management protection ("node was
// prevented from modifying apps"), so only reinstall when the applet changed.
export function installUrlHandler({ force = false } = {}) {
  if (process.platform !== 'darwin')
    throw new Error('The link handler is macOS only; use the http links instead.');
  const script = linkHandlerScript();
  const stamp = path.join(homeDir, 'link-handler.sha256');
  const hash = crypto.createHash('sha256').update(script).digest('hex');
  if (!force && fs.existsSync(appPath) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) {
    console.log(`Link handler is up to date (${appPath}).`);
    return;
  }
  const source = path.join(os.tmpdir(), `agentic-browser-links-${process.pid}.applescript`);
  fs.writeFileSync(source, script);
  execFileSync('osacompile', ['-o', appPath, source], { stdio: 'pipe' });
  fs.rmSync(source, { force: true });
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const set = (...args: string[]) => execFileSync('/usr/libexec/PlistBuddy', ['-c', args.join(' '), plist], { stdio: 'pipe' });
  try {
    set('Set', ':CFBundleIdentifier', linkHandlerBundleId);
  } catch {
    set('Add', ':CFBundleIdentifier', 'string', linkHandlerBundleId);
  }
  set('Add', ':LSUIElement', 'bool', 'true');
  set('Add', ':CFBundleURLTypes', 'array');
  set('Add', ':CFBundleURLTypes:0', 'dict');
  set('Add', ':CFBundleURLTypes:0:CFBundleURLName', 'string', 'Agentic browser tab link');
  set('Add', ':CFBundleURLTypes:0:CFBundleURLSchemes', 'array');
  set('Add', ':CFBundleURLTypes:0:CFBundleURLSchemes:0', 'string', linkScheme);
  // Editing Info.plist invalidates the applet's ad-hoc signature; Apple Silicon refuses unsigned apps.
  execFileSync('codesign', ['--force', '--sign', '-', appPath], { stdio: 'pipe' });
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', appPath]);
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(stamp, hash);
  console.log(`Installed the link handler (${appPath}).`);
}

export function linkHandlerScript() {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(cli)} open-link `;
  // agentic-browser://raise/<pid> brings that process to the front. macOS only
  // honors activation requests from the active app; the gateway runs in the
  // background, but this applet is active while it handles a URL.
  return [
    'use framework "AppKit"',
    'use scripting additions',
    'on open location theURL',
    // Tab links (http://127.0.0.1:<port>/focus?target=…) routed here by a link
    // router such as Finicky: ask that gateway to show the tab, bypassing the
    // everyday browser. In the background, so this applet quits right away.
    '  if theURL starts with "http://127.0.0.1:" and theURL contains "/focus?" then',
    '    do shell script "curl -s -m 10 " & quoted form of (theURL & "&go=1") & " > /dev/null 2>&1 &"',
    '  else if theURL starts with "' + linkScheme + '://raise/" then',
    '    set AppleScript\'s text item delimiters to "/"',
    '    set pidText to last text item of theURL',
    '    set AppleScript\'s text item delimiters to ""',
    '    set theApp to current application\'s NSRunningApplication\'s runningApplicationWithProcessIdentifier:(pidText as integer)',
    '    if theApp is not missing value then theApp\'s activateWithOptions:3',
    '  else',
    `    do shell script "${command.replace(/"/g, '\\"')}" & quoted form of theURL & " > /dev/null 2>&1 &"`,
    '  end if',
    'end open location',
  ].join('\n');
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
}

function shellQuote(text: string) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export const linkHandlerBundleId = 'dev.agentic-playwright-mcp.links';

// ~/.finicky.js: tab links of these profiles go to the link handler applet,
// everything else to the user's browser.
export function finickyConfig(ports: number[], defaultBrowser: string) {
  return `// Generated by agentic-playwright-mcp (finicky-config). Agent browser tab
// links open the agent browser window; every other link opens in ${defaultBrowser}.
const agentBrowserPorts = ${JSON.stringify(ports.map(String))};

export default {
  defaultBrowser: ${JSON.stringify(defaultBrowser)},
  handlers: [
    {
      match: url => url.hostname === "127.0.0.1" && agentBrowserPorts.includes(url.port) && url.pathname === "/focus",
      browser: { name: "${linkHandlerBundleId}", appType: "bundleId" },
    },
  ],
};
`;
}
