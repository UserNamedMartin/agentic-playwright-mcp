// Addresses no agent's tab or request may go to: the browser's own pages
// (chrome://history, tab search, inspect, ... list every chat's tabs, and
// chrome://version shows the DevTools port), the DevTools HTTP endpoint
// (/json/list lists every tab, /json/close/<id> closes one) and the
// gateway's own pages (the status page, tab links that raise the window).
//
// This covers what agents do through the browser tools; any local process can
// still reach the DevTools port directly (see README, "Things to know").

const allowedAbout = new Set(['about:blank', 'about:srcdoc']);

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
  if (['chrome:', 'chrome-untrusted:', 'devtools:', 'chrome-extension:', 'chrome-search:', 'edge:', 'brave:'].includes(scheme))
    return 'the browser\'s own pages show every chat\'s tabs';
  if (scheme === 'about:' && !allowedAbout.has(`about:${parsed.pathname}`) && !allowedAbout.has(target.split(/[?#]/)[0]))
    return 'the browser\'s own pages show every chat\'s tabs';
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
