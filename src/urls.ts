// Addresses no agent's tab or request may go to: the DevTools HTTP endpoint
// (/json/list lists every tab, /json/close/<id> closes one) and the
// gateway's own pages (the status page, tab links that raise the window).
// Nothing legitimate needs them, and they act on every chat at once.
// The browser's own pages (chrome://...) stay open: agents know they share
// the browser (see the skill), and may need them.
//
// This covers what agents do through the browser tools; any local process can
// still reach the DevTools port directly (see README, "Things to know").

function isLoopback(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost'))
    return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0')
    return true;
  if (host === '::1' || host === '::')
    return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, normalized to ::ffff:7f00:1).
  const mapped = host.match(/^::ffff:(.+)$/);
  if (mapped)
    return /^127\./.test(mapped[1]) || /^7f[0-9a-f]{2}:/.test(mapped[1]);
  return false;
}

// Why `url` is off limits, or undefined when it is fine.
export function internalUrl(url: string, ports: string[]): string | undefined {
  let target = String(url ?? '').trim();
  while (/^view-source:/i.test(target))
    target = target.replace(/^view-source:/i, '');
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol;
  if ((scheme === 'http:' || scheme === 'https:') && isLoopback(parsed.hostname)) {
    const port = parsed.port || (scheme === 'https:' ? '443' : '80');
    if (ports.includes(port))
      return 'the browser\'s DevTools port and the gateway\'s own pages act on every chat\'s tabs';
  }
  return undefined;
}

export function refuseInternalUrl(url: string, ports: string[]) {
  const reason = internalUrl(url, ports);
  if (reason)
    throw new Error(`${url} is not available to agents: ${reason}.`);
}
