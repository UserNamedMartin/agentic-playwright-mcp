---
status: open
area: front
found: 2026-11-19
filed: 2026-11-20
reproducible: sometimes (seen twice in a row, same chat; not yet tried on another site)
suspect: unknown
fixed-in:
---

# A page behaves differently while the browser is out of sight: GitHub's OAuth "Authorize" button never enables

## Symptoms

During a GitHub CLI device-flow login (`gh auth login --web`) the agent entered the user code on
`https://github.com/login/device`, pressed Continue and landed on
`https://github.com/login/device/confirmation` ("Authorize GitHub CLI"). The "Authorize github" button
(`button.js-oauth-authorize-btn`, `name=authorize value=1`) stayed `disabled` for minutes:

```
browser_click target="internal:role=button[name=\"Authorize github\"i] >> nth=0" timeout=30
→ TimeoutError … element is not enabled (retried ~12 times)
```

The first device code expired (15 min) while the button stayed disabled. On the second attempt the
user opened the tab with a tab link (window in front) and the button enabled; the login then
completed. So the same page works in view and does not work out of sight.

The user's point, beyond this site: an agent should not have to care whether the browser window is
minimized. Any page difference between "out of sight" and "in view" forces a human click and makes
unattended work fail.

## Environment

Claude Code desktop, main chat only, one agent using the browser, headed gated browser on macOS,
out of sight (minimized and hidden) as usual. Gateway restarted with `launchctl kickstart -k` ≈ 25 min
earlier (tabs restored); one "browser connection lost; reconnecting" at 23:07:31Z, between the
two attempts.

## Steps to reproduce

1. With the profile out of sight, start `gh auth login --web` in a shell and read the one-time code.
2. `browser_navigate https://github.com/login/device`, continue as the signed-in account, type the
   code, press Continue.
3. On the "Authorize GitHub CLI" page wait 10–30 s, then click "Authorize github".
   Expected: the button is enabled after GitHub's short delay and the click goes through.
   Actual: the button stays `disabled`; the click times out.
4. Bring the window to the front (tab link). Expected = actual: the button enables, click works.

Not yet tried: the same page with stock Playwright headed + minimized, and headless.

## Evidence

- Click call log above (2026-11-19 ≈ 23:02:40Z, and again ≈ 23:17:30Z).
- In the same tab, while out of sight, the page itself sees itself as visible and focused, and
  rendering callbacks run (checked 23:32Z):
  `requestAnimationFrame` fired, `IntersectionObserver` fired with `isIntersecting=true`,
  `document.visibilityState = "visible"`, `document.hasFocus() = true`.
  So the usual suspects (rAF/occlusion throttling, Page Visibility) are ruled out — `--disable-renderer-backgrounding`,
  `--disable-backgrounding-occluded-windows` and `--disable-background-timer-throttling` are in effect.
- `gateway.log` for the period has only the reconnect lines (23:07:31Z–23:07:32Z); no errors.

## Cause

Not known. Hypotheses, in order of likelihood:

1. GitHub's clickjacking guard waits for a real window `focus` event or a real pointer/mouse event
   (trusted input reaching the window) before enabling the button. A minimized, hidden window gets
   neither; `hasFocus()` is true through focus emulation, but no `focus`/`pointermove` event is ever
   dispatched. Would settle it: log `focus`, `blur`, `pointermove`, `mousemove`, `visibilitychange`
   listeners on that page (via an init script) and see which one enables the button.
2. Something tied to the window's on-screen geometry (e.g. `window.screenX/outerWidth` of a minimized
   window, or `matchMedia` results) that GitHub checks. Would settle it: compare these values in and
   out of sight.

## Suggested fix

Make an out-of-sight tab indistinguishable from an in-view one for the page:

- when an agent's tab becomes active (navigate/click/type on it), dispatch the events a real
  foreground window gets — `window` `focus`, `document` `visibilitychange` (already `visible`), and a
  synthetic trusted `mousemove` over the viewport through `Input.dispatchMouseEvent` — before the
  agent's action;
- or keep the browser window un-minimized but off-screen/behind (occluded instead of minimized), if
  that keeps it out of sight on macOS without the side effects fixed in
  `2026-10-12-gate-strands-home-window.md`.

Test: a local page that enables a button only after a `focus` event and a `mousemove` (and one that
checks window geometry); with the profile out of sight, `browser_click` on it must succeed within
the page's delay. Then the real GitHub device flow as a manual check.

## Workaround

Give the user a tab link and ask for the one click. Device codes expire after 15 minutes, so enter the
code right before sending the link.
