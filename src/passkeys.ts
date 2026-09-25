// Passkey (WebAuthn) requests: navigator.credentials.get/create with publicKey.
// The browser's passkey prompt needs someone at the window. In the hidden
// browser nobody sees it, so the request used to hang until the site gave up
// ("the request timed out") and the agent never learned why; the page's other
// buttons often do nothing meanwhile. Instead a page script asks the gateway
// first:
// - nobody can see the browser (hidden, minimized or headless): the request is
//   cancelled at once, as if the prompt was dismissed (NotAllowedError), so the
//   site offers its other ways to sign in right away;
// - the window is in front (the user opened a tab link): the request goes on
//   to the browser and its prompt is the user's to answer.
// Either way the agent reads about it in its next tool result. Passive requests
// (mediation "conditional", passkey autofill) are left alone: they wait for a
// click in an autofill list and never block the page.
import type { Page } from 'playwright-core';

export const passkeyBinding = '__agenticPasskey';

export type PasskeyRequest = {
  page: Page;
  tab: string;
  origin: string;
  frameOrigin: string;
  // 'get' signs in with a passkey, 'create' registers a new one.
  kind: 'get' | 'create';
  // Cancelled because nobody could see the browser, or passed on to it.
  cancelled: boolean;
};

export function describePasskeyRequests(requests: PasskeyRequest[]): string | undefined {
  if (!requests.length)
    return undefined;
  const lines = requests.map(r => {
    const where = `${r.frameOrigin}${r.frameOrigin !== r.origin ? ` (in ${r.origin})` : ''}`;
    const what = r.kind === 'get' ? 'asked to sign in with a passkey' : 'asked to create a passkey';
    return r.cancelled
      ? `- Tab ${r.tab}: ${where} ${what}. Nobody can see this browser, so the request was cancelled at once, as if the ` +
        'passkey prompt had been dismissed.'
      : `- Tab ${r.tab}: ${where} ${what}. The browser window is in front, so the passkey prompt was shown: it is the ` +
        'user\'s to answer.';
  });
  return `### Passkey requests\n${lines.join('\n')}\nAgents cannot use passkeys. To sign in, pick another way the page offers ` +
    '(often "Try another way", then the password) and follow the Logins rules of the agentic-browser skill. If the user ' +
    'wants to use their passkey, give them a browser_tab_link to the page and let them start the sign-in there.';
}

// Wraps CredentialsContainer.get/create. The gateway answers 'cancel' or
// 'proceed'; without the gateway the call goes through unchanged.
export const passkeyScript = `(() => {
  if (window.__agenticPasskeyHooks)
    return;
  window.__agenticPasskeyHooks = true;
  const binding = ${JSON.stringify(passkeyBinding)};
  const proto = window.CredentialsContainer && CredentialsContainer.prototype;
  for (const kind of ['get', 'create']) {
    const original = proto && proto[kind];
    if (typeof original !== 'function')
      continue;
    const wrapped = function(options, ...rest) {
      if (!options || !options.publicKey || options.mediation === 'conditional' || typeof window[binding] !== 'function')
        return original.call(this, options, ...rest);
      return window[binding]({ kind }).catch(() => 'proceed').then(answer => answer === 'cancel'
        ? Promise.reject(new DOMException('Passkeys cannot be used in this browser: nobody can see its prompt.', 'NotAllowedError'))
        : original.call(this, options, ...rest));
    };
    try {
      Object.defineProperty(proto, kind, { value: wrapped, writable: true, configurable: true });
    } catch {}
  }
})();`;
