// Runs a profile's browser and gateway only while one of its client apps is
// running: starts them when a matching process appears, stops them a while
// after the last one is gone. Without activateWith rules they just run.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Gateway } from './gateway.js';
import { cdpEndpoint, closeBrowser, startBrowser } from './launcher.js';
import { homeDir, profileBadge, type Profile } from './profiles.js';

const execFileAsync = promisify(execFile);

type Options = { caps?: string[]; keepTabsOnExit?: boolean };

export async function runProfile(profile: Profile, options: Options) {
  let gateway: Gateway | undefined;
  let busy = false;
  let lastSeen = 0;
  const rules = (profile.activateWith ?? []).map(r => ({ match: new RegExp(r.match), exclude: r.exclude ? new RegExp(r.exclude) : undefined }));
  const graceMs = profile.stopAfterMs ?? 2 * 60 * 1000;

  const start = async () => {
    await startBrowser(profile);
    gateway = new Gateway({
      profile: profile.name,
      cdpEndpoint: cdpEndpoint(profile),
      port: profile.port,
      caps: options.caps ?? profile.caps,
      keepTabsOnExit: options.keepTabsOnExit,
      filesDir: profile.filesDir ?? path.join(homeDir, 'profiles', profile.name, 'files'),
      filesRetentionDays: profile.filesRetentionDays,
      ...profileBadge(profile),
      executablePath: profile.executablePath,
      dockIconCache: path.join(homeDir, 'profiles', profile.name, 'dock-icon-base.png'),
      stateFile: path.join(homeDir, 'profiles', profile.name, 'sessions.json'),
    });
    await gateway.start();
  };

  const stop = async (reason: string, { keepBrowser = false } = {}) => {
    console.error(`[${profile.name}] stopping: ${reason}${keepBrowser ? ' (the browser and its tabs stay for the next start)' : ''}`);
    await gateway?.stop({ keepBrowser });
    gateway = undefined;
    if (!keepBrowser)
      await closeBrowser(profile).catch(() => {});
  };

  // Ctrl+C in the foreground stops everything. SIGTERM comes from the service
  // manager (a service restart, or logout, which quits the browser anyway):
  // leave the browser running so the restarted gateway gives agents their
  // tabs back.
  process.on('SIGINT', () => void stop('SIGINT').finally(() => process.exit(0)));
  process.on('SIGTERM', () => void stop('SIGTERM', { keepBrowser: true }).finally(() => process.exit(0)));

  if (!rules.length) {
    await start();
    return;
  }

  const tick = async () => {
    if (busy)
      return;
    busy = true;
    try {
      if (await anyProcessMatches(rules))
        lastSeen = Date.now();
      const wanted = Date.now() - lastSeen < graceMs;
      if (wanted && !gateway)
        await start();
      else if (!wanted && gateway)
        await stop('no client app running');
    } catch (e) {
      console.error(`[${profile.name}] ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  console.error(`[${profile.name}] waiting for: ${profile.activateWith!.map(r => r.match).join(' | ')}`);
  await tick();
  setInterval(() => void tick(), 2000);
}

async function anyProcessMatches(rules: { match: RegExp; exclude?: RegExp }[]) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').some(command => rules.some(r => r.match.test(command) && !r.exclude?.test(command)));
}
