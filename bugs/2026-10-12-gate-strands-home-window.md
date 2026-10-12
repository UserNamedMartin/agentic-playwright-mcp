---
status: open
area: front
found: 2026-10-12
filed: 2026-10-12
reproducible: yes (every tab link and browser_show_tab in a gated browser)
fixed-in:
---

# The show gate keeps the home window from ever being ordered in, so no tab link can show it

## Symptoms
Since the profiles switched to the gated browser, a tab link (or `browser_show_tab`) shows the
browser for about three seconds and then it disappears again. The user saw "the browser window
crashes" each time. What was on screen was not the agent's tab but an empty `chrome://newtab`
window; the window holding the agents' tabs (and the status page) never came out of the Dock.
DevTools reported that window `minimized` before, during and after the tab link.

## Environment
Claude Code desktop, one chat, a login flow that needed the user in the page. Gated browser
running since its first start after `5fb6b99` (2026-10-09), never restarted since.

## Steps to reproduce
1. Start a profile on the gated browser (headed, macOS); let the gateway put it out of sight.
2. Open a tab as an agent; call `browser_show_tab` (or click its tab link).
3. Expected: the tab's window un-minimized and frontmost, and it stays.
   Actual: the app is unhidden and frontmost, the window stays minimized; 3 s later the focus
   guard logs `window minimized; hiding the browser too` and hides the app, 5 s later
   `front: the window did not come into view after a tab link`.

A click on the browser's Dock icon fails the same way: the app comes up, the home window stays
minimized, and the focus guard hides the app again 3 s later (reproduced with `open -a <bundle>`,
which sends the running app the same reopen event).

`test/show-gate.mjs` passed anyway: its last check counted any sample with the app unhidden or
frontmost as "shown".

## Evidence
- `profiles/<profile>/gateway.log`: no tab link has shown a window since the gated browser
  started; four tab links on 2026-10-12 each followed by `window minimized; hiding the browser
  too` 2.3–3 s later.
- `profiles/<profile>/show-gate.log`: the first line after the gated browser started is
  `blocked -[NSWindow orderWindow:relativeTo:] (#1)`, at the moment the gateway created the
  home window. Nothing was blocked during the tab links themselves.
- Throwaway profiles (scratch probe, window state sampled every 50 ms through DevTools and the
  window server's window list):
  - stock Chrome, gated copy without the gate loaded, and gated copy with
    `orderWindow:relativeTo:` left unhooked: the window turns `normal` 0.6–0.9 s after the tab
    link, also when it is un-minimized while the app is still hidden;
  - gated copy as shipped: the window stays `minimized` in every variant (focusTab's order,
    waiting until the app is unhidden first, un-minimizing while hidden), although the gate
    let every `deminiaturize:` through (logged with an "allowed" line);
  - gated copy with the gate held open only while the gateway created the home window:
    the tab link works like stock Chrome.

## Cause
Confirmed:
- The gateway creates its home window with `Target.createTarget({ newWindow, windowState:
  'minimized' })` while the browser is out of sight. Chrome orders the new window in and then
  miniaturizes it. The gate refuses the order-in (no deadline in the gate file), so the window
  is never ordered in: Chrome records it as minimized, but there is nothing in the Dock to
  deminiaturize. Every later `deminiaturize:` (focusTab's `setWindowState('normal')`) does
  nothing.
- The gateway could not have opened the gate for it anyway: `src/gateway.ts` set
  `shared.showGatePath` inside the `onVisibilityChanged` callback (a misplaced line from
  `5fb6b99`), so it was undefined until the first visibility change, after the home window had
  been created.

The empty `normal` windows are a separate effect: when the app is shown with no visible window
(a Dock click, or this bug), Chrome opens a new window; the focus guard only watches the home
window, so these stay behind and come up with the next show.

## Suggested fix
Assign `showGatePath` right after connecting, and open the gate briefly while the gateway
creates its own window (`createTarget({ newWindow })`): the gate is there to stop pages, not
the gateway's own minimized window. Opening the gate must never shorten a deadline focusTab set.
`test/show-gate.mjs`: after `browser_show_tab`, wait past the focus guard's 3 s and check the
tab's window is `normal`, the app is not hidden and frontmost, and the gateway logged nothing
that hid it again.

## Workaround
None from the agent side. A browser that started on a gated copy keeps its stranded home
window until the browser restarts with the fix.
