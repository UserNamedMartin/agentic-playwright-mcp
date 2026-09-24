// Runs `agentic-playwright-mcp start <profile>` at login and restarts it if it
// exits (the gateway exits when its browser goes away). macOS launchd only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, type Profile } from './profiles.js';

function label(profile: Profile) {
  return `dev.agentic-playwright-mcp.${profile.name}`;
}

function plistPath(profile: Profile) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label(profile)}.plist`);
}

export function installService(profile: Profile) {
  if (process.platform !== 'darwin')
    throw new Error('service install currently supports macOS only; run "agentic-playwright-mcp start <profile>" with your own supervisor.');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const log = path.join(homeDir, 'profiles', profile.name, 'gateway.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const args = [process.execPath, cli, 'start', profile.name].map(a => `    <string>${escapeXml(a)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(profile)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${process.env.AGENTIC_PLAYWRIGHT_HOME ? `  <key>EnvironmentVariables</key>
  <dict><key>AGENTIC_PLAYWRIGHT_HOME</key><string>${escapeXml(homeDir)}</string></dict>
` : ''}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`;
  const file = plistPath(profile);
  if (fs.existsSync(file))
    launchctl(['bootout', `gui/${process.getuid!()}`, file], true);
  fs.writeFileSync(file, plist);
  launchctl(['bootstrap', `gui/${process.getuid!()}`, file]);
  console.log(`Installed ${label(profile)}; logs: ${log}`);
}

export function isServiceInstalled(profile: Profile) {
  return process.platform === 'darwin' && fs.existsSync(plistPath(profile));
}

export function stopService(profile: Profile) {
  launchctl(['bootout', `gui/${process.getuid!()}`, plistPath(profile)], true);
}

export function startService(profile: Profile) {
  launchctl(['bootstrap', `gui/${process.getuid!()}`, plistPath(profile)]);
}

export function uninstallService(profile: Profile) {
  const file = plistPath(profile);
  if (fs.existsSync(file)) {
    launchctl(['bootout', `gui/${process.getuid!()}`, file], true);
    fs.unlinkSync(file);
  }
  console.log(`Uninstalled ${label(profile)}.`);
}

function launchctl(args: string[], ignoreErrors = false) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
  } catch (e) {
    if (!ignoreErrors)
      throw e;
  }
}

function escapeXml(text: string) {
  return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
