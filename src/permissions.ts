// Permission requests (camera, microphone, location, notifications, ...).
// In a hidden browser nobody sees Chrome's permission prompt, so the page waits
// forever and the agent never learns why. Instead:
// - the browser runs with --deny-permission-prompts, so no prompt is ever shown
//   (and nothing hangs): a request without a decision is refused;
// - the page hook (pagehooks.ts) tells the gateway about each request before
//   the browser sees it; the agent reads about it in its next tool result and answers with
//   browser_permission, which sets the permission for that site;
// - requests that can wait (camera, microphone, location, notifications,
//   MIDI) are held until the agent answers, for up to holdMs, so the page then
//   simply gets its answer. The others need the user's click to still be fresh,
//   so they go ahead at once (refused unless allowed before) and the agent
//   repeats the action after allowing.
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
  targetId: string;
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

// The page side lives in the page hook (pagehooks.ts).
