// A profile is one named, persistent browser plus the gateway in front of it.
// Everything that should stay logged in lives in the profile's userDataDir,
// independent of which project folder an agent runs in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Profile = {
  name: string;
  port: number;          // MCP gateway (HTTP)
  cdpPort: number;       // browser remote debugging
  userDataDir: string;
  executablePath: string;
  headless?: boolean;
  caps?: string[];
  // Run only while a matching process is running (regexes over the full
  // command line). Empty or missing: always run.
  activateWith?: { match: string; exclude?: string }[];
  stopAfterMs?: number;
};

export const homeDir = process.env.AGENTIC_PLAYWRIGHT_HOME ?? path.join(os.homedir(), '.agentic-playwright-mcp');
const profilesFile = path.join(homeDir, 'profiles.json');

const knownBrowsers: Record<string, string[]> = {
  chrome: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ],
  brave: [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/brave-browser',
  ],
  chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge'],
};

export function resolveExecutable(browser: string) {
  if (fs.existsSync(browser))
    return browser;
  const found = knownBrowsers[browser]?.find(p => fs.existsSync(p));
  if (!found)
    throw new Error(`Browser "${browser}" not found. Pass one of ${Object.keys(knownBrowsers).join(', ')} or a path to the executable.`);
  return found;
}

export function loadProfiles(): Profile[] {
  try {
    return JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveProfiles(profiles: Profile[]) {
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2) + '\n');
}

export function getProfile(name: string): Profile {
  const profile = loadProfiles().find(p => p.name === name);
  if (!profile)
    throw new Error(`No profile "${name}". Create it with: agentic-playwright-mcp profile add ${name}`);
  return profile;
}

export function addProfile(name: string, options: { browser?: string; port?: number; cdpPort?: number; headless?: boolean }): Profile {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name))
    throw new Error('Profile names may contain letters, digits, "-" and "_".');
  const profiles = loadProfiles();
  if (profiles.some(p => p.name === name))
    throw new Error(`Profile "${name}" already exists.`);
  const index = profiles.length;
  const profile: Profile = {
    name,
    port: options.port ?? nextFree(profiles.map(p => p.port), 8931 + index),
    cdpPort: options.cdpPort ?? nextFree(profiles.map(p => p.cdpPort), 9231 + index),
    userDataDir: path.join(homeDir, 'profiles', name, 'browser-data'),
    executablePath: resolveExecutable(options.browser ?? 'chrome'),
    headless: options.headless,
  };
  saveProfiles([...profiles, profile]);
  return profile;
}

export function updateProfile(name: string, patch: Partial<Profile>): Profile {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.name === name);
  if (!profile)
    throw new Error(`No profile "${name}".`);
  Object.assign(profile, patch);
  saveProfiles(profiles);
  return profile;
}

export function removeProfile(name: string) {
  const profiles = loadProfiles();
  if (!profiles.some(p => p.name === name))
    throw new Error(`No profile "${name}".`);
  saveProfiles(profiles.filter(p => p.name !== name));
}

function nextFree(used: number[], start: number) {
  let port = start;
  while (used.includes(port))
    port++;
  return port;
}
