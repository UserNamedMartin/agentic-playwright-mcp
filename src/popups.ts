// Links that open a new tab (target="_blank", named targets, Cmd/Ctrl-click)
// would make Chrome open a foreground tab and raise its window. A page script
// cancels such clicks and asks the gateway to open the URL as a background tab
// of the session that owns the page. It runs last (window, bubble phase) and
// skips clicks the site already handled, so sites that open windows from their
// own click handlers keep working. Browsers open target=_blank links without
// an opener anyway, so nothing is lost; links that ask for rel="opener" and
// window.open() calls (sign-in popups rely on the opener) are left alone.
export const openInBackgroundBinding = '__agenticOpenInBackground';

export const popupInterceptScript = `(() => {
  if (window.__agenticPopupIntercept)
    return;
  window.__agenticPopupIntercept = true;
  window.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey)
      return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.href);
    if (!anchor || anchor.hasAttribute('download') || anchor.relList.contains('opener') || !/^https?:/.test(anchor.href))
      return;
    const target = (anchor.getAttribute('target') || '').toLowerCase();
    const newTab = (target && !['_self', '_parent', '_top'].includes(target)) || event.metaKey || event.ctrlKey;
    if (!newTab || typeof window.${openInBackgroundBinding} !== 'function')
      return;
    event.preventDefault();
    window.${openInBackgroundBinding}(anchor.href);
  });
})();`;
