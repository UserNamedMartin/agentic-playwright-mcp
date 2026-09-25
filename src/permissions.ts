// Permission requests (camera, microphone, location, notifications, ...).
// In a hidden browser nobody sees Chrome's permission prompt, so the page waits
// forever and the agent never learns why. Instead:
// - the browser runs with --deny-permission-prompts, so no prompt is ever shown
//   (and nothing hangs): a request without a decision is refused;
// - a page script tells the gateway about each request before the browser sees
//   it; the agent reads about it in its next tool result and answers with
//   browser_permission, which sets the permission for that site;
// - requests that can wait (camera, microphone, location, notifications,
//   MIDI) are held until the agent answers, for up to holdMs, so the page then
//   simply gets its answer. The others need the user's click to still be fresh,
//   so they go ahead at once (refused unless allowed before) and the agent
//   repeats the action after allowing.
import type { Page } from 'playwright-core';

export const permissionBinding = '__agenticPermission';
// AGENTIC_PERMISSION_HOLD_MS shortens it for tests.
export const holdMs = Number(process.env.AGENTIC_PERMISSION_HOLD_MS) || 2 * 60 * 1000;

// Names agents use (the Permissions API names) and the permission descriptor
// names Browser.setPermission takes for them (several where Chrome versions
// differ; unknown ones are skipped).
export const permissionTypes: Record<string, string[]> = {
  'camera': ['camera'],
  'microphone': ['microphone'],
  'geolocation': ['geolocation'],
  'notifications': ['notifications'],
  'clipboard-read': ['clipboard-read'],
  'midi': ['midi'],
  'local-fonts': ['local-fonts'],
  'idle-detection': ['idle-detection'],
  'window-management': ['window-management'],
  'storage-access': ['storage-access'],
  'local-network': ['local-network-access', 'local-network', 'loopback-network'],
};

export type PermissionRequest = {
  page: Page;
  tab: string;
  // The page (top-level) origin and the requesting frame's origin.
  origin: string;
  frameOrigin: string;
  permissions: string[];
  api: string;
  // Held until the agent answers (see holdMs).
  waiting: boolean;
  status: 'pending' | 'refused' | 'allowed' | 'denied' | 'timed out';
  announced: boolean;
  at: number;
  resolve?: () => void;
};

export function describeRequests(requests: PermissionRequest[]): string | undefined {
  const lines = [];
  for (const r of requests) {
    const what = `Tab ${r.tab}: ${r.frameOrigin}${r.frameOrigin !== r.origin ? ` (in ${r.origin})` : ''} asks for ${r.permissions.join(', ')} (${r.api})`;
    if (r.status === 'pending')
      lines.push(`- ${what}. The page is waiting for your answer (up to ${Math.round(holdMs / 1000)} seconds).`);
    else if (r.status === 'refused')
      lines.push(`- ${what}. It was refused automatically; if the task needs it, allow it and repeat the action.`);
    else if (r.status === 'timed out')
      lines.push(`- ${what}. Nobody answered, so it was refused; if the task needs it, allow it and repeat the action.`);
  }
  if (!lines.length)
    return undefined;
  return `### Permission requests\n${lines.join('\n')}\nAnswer with browser_permission (decision "allow" or "deny"). Allow only what the ` +
    'task needs; deny notifications unless the task is about them.';
}

// Wraps the web APIs that ask for permissions. Each request is reported to the
// gateway first; "hold" requests wait for the agent's answer.
export const permissionScript = `(() => {
  if (window.__agenticPermissionHooks)
    return;
  window.__agenticPermissionHooks = true;
  const binding = ${JSON.stringify(permissionBinding)};
  // Reported synchronously, so the agent usually reads about it in the result
  // of the very call (a click) that caused it. The gateway knows which
  // permissions were decided and answers those at once.
  const ask = (permissions, api, hold) => {
    if (typeof window[binding] !== 'function')
      return Promise.resolve();
    return window[binding]({ permissions, api, hold }).catch(() => {});
  };
  // kind: 'hold' (wait for the answer, API returns a promise), 'callback' (wait,
  // API returns nothing), 'report' (tell the gateway and go ahead).
  const hook = (target, name, permissions, kind) => {
    const original = target && target[name];
    if (typeof original !== 'function')
      return;
    const wrapped = function(...args) {
      let names = [];
      try {
        names = typeof permissions === 'function' ? permissions(...args) : permissions;
      } catch {}
      if (!names.length)
        return original.apply(this, args);
      if (kind === 'report') {
        ask(names, name, false);
        return original.apply(this, args);
      }
      const call = ask(names, name, true).then(() => original.apply(this, args));
      return kind === 'callback' ? undefined : call;
    };
    try {
      Object.defineProperty(target, name, { value: wrapped, writable: true, configurable: true });
    } catch {}
  };
  const media = c => [...(c && c.audio ? ['microphone'] : []), ...(c && c.video ? ['camera'] : [])];
  hook(window.MediaDevices && MediaDevices.prototype, 'getUserMedia', media, 'hold');
  hook(window.Geolocation && Geolocation.prototype, 'getCurrentPosition', ['geolocation'], 'callback');
  hook(window.Geolocation && Geolocation.prototype, 'watchPosition', ['geolocation'], 'report');
  hook(window.Notification, 'requestPermission', ['notifications'], 'hold');
  hook(window.PushManager && PushManager.prototype, 'subscribe', ['notifications'], 'hold');
  hook(window.Navigator && Navigator.prototype, 'requestMIDIAccess', ['midi'], 'hold');
  hook(window.Clipboard && Clipboard.prototype, 'readText', ['clipboard-read'], 'report');
  hook(window.Clipboard && Clipboard.prototype, 'read', ['clipboard-read'], 'report');
  hook(window, 'queryLocalFonts', ['local-fonts'], 'report');
  hook(window.IdleDetector, 'requestPermission', ['idle-detection'], 'report');
  hook(window, 'getScreenDetails', ['window-management'], 'report');
  hook(window.Document && Document.prototype, 'requestStorageAccess', ['storage-access'], 'report');
})();`;
