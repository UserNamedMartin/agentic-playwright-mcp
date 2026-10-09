---
status: fixed
area: front
found: 2026-10-08
filed: 2026-10-09
reproducible: yes (any page that calls window.open from its own script while the browser is out of sight)
fixed-in: 5fb6b99 (test/show-gate.mjs)
---

# A page can show the hidden browser; the focus guard only hides it again afterwards

## Symptoms
For about eight minutes the user's screen flashed the agent browser over and over: the window came
up for a fraction of a second and went away again, more than a hundred times as the user saw it.
Nobody had asked to see the browser.

## Environment
Claude Code desktop, one chat, four background subagents started within two minutes, each
researching companies in a national business register whose "open extract" button opens the
extract (a `blob:` PDF) in a new tab from the page's own script (`window.open`). The browser was out
of sight (window minimized and app hidden), as it normally is.

## Steps to reproduce
1. Profile out of sight (minimized and hidden), headed, on macOS.
2. In an agent tab, run a page script that calls `window.open(url)` (a user-activated click on a
   button whose handler calls `window.open`, as the register does; a `blob:` URL is enough).
3. Expected: a new background tab, nothing on screen. Actual: Chrome opens the tab in front,
   macOS shows the hidden app, the focus guard hides it again 0.1–3 s later: one flash per call.

## Evidence
- `profiles/<profile>/gateway.log`, 2026-10-08 20:31:18Z–20:39:37Z: 48 lines
  `focus guard: a page showed the browser; hiding it again`, the first 17 s after the fourth
  subagent session started (`session started: … · FI enrich 3`, 20:31:00Z), the last when they
  finished with the register. In the 40 minutes before, other subagents used the browser
  (LinkedIn, company sites) with no such line.
- The subagents reported it themselves: "the free register extract opens as a blob PDF in a new
  tab"; one left 11 blank tabs behind from repeated attempts.
- Before this day the line occurs a handful of times in total (2026-09-24 … 2026-09-30).

## Cause
Confirmed in the code:
- `src/popups.ts` turns link clicks that would open a new tab into background tabs, but leaves a
  page's own `window.open()` calls alone on purpose (sign-in popups need their opener).
- Chrome opens such a tab or popup window in the foreground. Ordering a window in makes AppKit
  unhide and activate the hidden app.
- `src/browser.ts` `_guardFocus()` runs on `Target.targetCreated` and polls every 100 ms until it
  sees the app shown, then hides it again. It can only react after the browser is already on
  screen, so every call is a flash.

The design flaw underneath: the browser being out of sight is held by undoing what Chrome does
(hide after show), so anything that makes Chrome show itself wins the race. Intercepting one more
way in (window.open, form `target=_blank`, PDF viewer, `window.focus()`) would only move the race to
the next way in.

## Suggested fix
Stop the show at its source, in one place: inside the browser process, gate the AppKit calls that
make the app visible (`-[NSApplication activate…]`, `-[NSApplication unhide…]`,
`-[NSRunningApplication activateWithOptions:]`, `-[NSWindow orderWindow:relativeTo:]` for ordering
in, `-[NSWindow deminiaturize:]`). They pass only when the gateway has opened the gate for a user
request (`focusTab`) or the user has made the app active themselves (Dock, Cmd-Tab). Google Chrome's
signature does not allow loading a library, so the profiles run a copy of Google Chrome with the
gate library added and the copy re-signed with a stable local identity (same profile, same
browser, nothing else changes).

Test: a headed run with the browser out of sight where pages call `window.open` (tab and popup
window), submit a form with `target=_blank`, open a PDF and call `window.focus()`; the app must stay
hidden and never become frontmost, and `focusTab` must still show the window.

## Workaround
None that agents can rely on. Avoid page buttons that open documents in a new tab (fetch the
document's URL instead).

## Fix
The gated browser (`src/gatedbrowser.ts`, `native/show-gate/show_gate.m`): a copy of Google Chrome,
re-signed (top level only; nested code keeps Google's signature) so its main process may take
`DYLD_INSERT_LIBRARIES`; the launcher loads the show gate into it. The gate swizzles the AppKit
methods that put the app on screen, on `NSApplication`, `NSWindow`, `NSRunningApplication` and every
subclass that overrides them (also in images loaded later), and lets them through only while the
gate file holds a future deadline (`SharedBrowser.focusTab` writes one) or the app is already active.
Chrome's main executable has no room for another load command, hence the environment variable.

Test: `test/show-gate.mjs` (headed): window.open blob and popup, form `target=_blank`, `rel=opener`
link, `window.focus()` — 0 samples on screen, no focus-guard line, 9 calls blocked, `browser_show_tab`
still shows the window. `--ungated` on stock Chrome fails: popup, form and opener link each put it on
screen and the focus guard hid it three times.
