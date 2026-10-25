---
status: open
area: sessions
found: 2026-10-25
filed: 2026-10-25
reproducible: yes
fixed-in:
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

Before a thread starts, check the session's tabs from the gateway's own connection: dismiss an open JavaScript dialog
(handled by the browser, works while the page waits), close a tab whose renderer does not answer within a few seconds,
and tell the agent which. Test: the case above.
