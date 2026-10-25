---
status: fixed
area: proxy
found: 2026-10-25
filed: 2026-10-25
reproducible: yes
fixed-in: bbfc230 (root, proxy; af253c5 was a session-level patch) — test/hangs.mjs stuck/busy/dialog cases
---

# A tab stuck in a script keeps its session's new thread from connecting; every call fails

## Symptoms

A subagent's tab (a search page) stopped responding (its title in tab lists became "not responding: the page is busy;
close this tab if it stays stuck"). After its thread was ended (`browser thread stopped answering during
browser_run_code_unsafe; ending it`), every further call of that session — including `browser_tabs` with action
`close`, the very thing the hint asks for — failed after 15 s with
`browserType.connectOverCDP: Timeout 15000ms exceeded`. The agent reported the tab as stuck in its group.

## Environment

Claude Code desktop, background subagent using a search engine in the browser, 2026-10-25 18:02–18:04 UTC.

## Steps to reproduce

`node test/hangs.mjs`, case "a stuck tab does not keep the session from reconnecting": one tab runs `for (;;) {}`,
another (other site) shows an `alert`, then the session's thread is ended (a given-up run_code).

- Expected: the next call answers; the stuck tab is closed or at least closable; the dialog tab stays.
- Actual (before the fix): every call takes 15 s and fails with the connectOverCDP timeout.

## Evidence

`profiles/<profile>/gateway.log` 18:02:58Z `… browser thread stopped answering during browser_run_code_unsafe; ending
it`, 18:03:46Z `browser_tabs from <chat> failed: Error: browserType.connectOverCDP: Timeout 15000ms exceeded.`
(logged under the parent chat's title because of 2026-10-25-subagent-calls-race-transcript).

## Cause

A new thread's Playwright connects through the proxy and initializes every tab it is attached to before
`connectOverCDP` resolves. A renderer stuck in a script (or waiting on a JavaScript dialog) answers no protocol command,
so the connection never completes. Inside a running thread the gateway already tolerates such tabs (2 s header timeout
in `worker.ts`), but a thread start does not.

## Suggested fix

(As filed; the root fix below replaced it.) Before a thread starts, check the session's tabs from the gateway's own connection: dismiss an open JavaScript dialog
(handled by the browser, works while the page waits), close a tab whose renderer does not answer within a few seconds,
and tell the agent which. Test: the case above.

## First fix (replaced by the root fix below)

af253c5: before a thread starts, `AgentSession._closeStuckTabs` dismisses JavaScript dialogs the gateway saw open on the session's tabs (`SharedBrowser.dismissDialog`, tracked from `Page.javascriptDialogOpening/Closed` on its own connection) and closes tabs whose renderer does not answer `Page.getFrameTree` within 5 s (`SharedBrowser.responsive`); the agent gets a "### Closed tabs" / "### Dialog dismissed" note. Two pages on one site can share a renderer, so a loop in one freezes both; the test uses two sites.

## Root fix

af253c5 probed tabs from the session before a thread started and closed any that did not answer within 5 s: a tab that
was only busy for a while was closed for good, and a tab could go silent between the probe and the connection. The
defect is that Playwright's connectOverCDP waits for every tab it is told about (`_waitForAllPagesToBeInitialized`), so
the place to decide is where tabs are told: the proxy. bbfc230: the proxy announces a tab only after it answers
`Page.getFrameTree` on the proxy's own session (2 s); a silent tab is left out (its session's messages are dropped),
re-checked every 2 s and announced when it answers, and closed after 60 s of silence. Dialogs left open are dismissed at
attach. The session-level check is removed.

An out-of-process iframe stuck inside a page that answers (checked after the fix): the page is not silent, a reconnect
takes ~0.3 s and the page stays in the list (test/hangs.mjs). What such a frame does slow down is upstream, not the
gateway: Playwright's `page.ariaSnapshot({ mode: 'ai' })`, which every snapshot-returning MCP tool calls, waits 30 s for
the stuck frame, and screenshots time out (the compositor waits on that renderer). Measured the same on stock Playwright
connected straight to Chrome (30 008 ms; `locator('body').ariaSnapshot()` 11 ms, click 24 ms), so nothing to fix here.
