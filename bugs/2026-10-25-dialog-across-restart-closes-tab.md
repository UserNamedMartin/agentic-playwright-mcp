---
status: fixed
area: sessions
found: 2026-10-25
filed: 2026-10-25
reproducible: yes
fixed-in: 3684a80 (test/reconnect.mjs, "a dialog open across the restart is dismissed, its tab kept")
---

# A JavaScript dialog open across a gateway restart makes its tab look stuck, and it gets closed

## Symptoms

Found while checking the stuck-tab root fix (bbfc230), not reported by an agent. After a gateway restart, a tab of a
chat that showed an `alert` was reported as "does not answer … left out" and would have been closed after 60 s; the
chat's tab list lost it.

## Environment

Self-contained test (`test/reconnect.mjs`), headless Chrome 155, gateway restarted with SIGTERM (as a service restart).

## Steps to reproduce

`node test/reconnect.mjs`, case "a dialog open across the restart is dismissed, its tab kept": a chat's page opens an
`alert`, the gateway restarts, the chat lists its tabs.

- Expected: the tab is still there; the dialog is gone and the agent told.
- Actual (before the fix): the tab is left out as silent (and closed after the limit).

## Evidence

Raw CDP against Chrome 155 (scratch script): with a dialog opened while another client was connected, a new client's
`Page.getFrameTree` and `Page.enable` get no answer, no `Page.javascriptDialogOpening` arrives after `Page.enable`, and
`Page.handleJavaScriptDialog` answers "No dialog is showing". A dialog is reachable only through a connection that saw it
open.

## Cause

The gateway tracks dialogs on its own connection and dismisses them when a session reconnects, but a restart replaces
that connection, so the new gateway cannot know about or dismiss the dialog, and the page answers nothing until it is
gone.

## Suggested fix

Dismiss the dialogs of agents' tabs while the old connection still sees them: on a graceful stop that keeps the browser
(service restart). Notes not yet delivered must survive the restart so the agent hears about it. A dropped connection
or a crash cannot be handled this way; the tab then stays "silent", and the note must say a lost dialog is a possible
cause.

## Fix

3684a80: `Gateway.stop({ keepBrowser: true })` dismisses the dialogs of owned tabs (`_dismissOwnedDialogs`) before it saves
state, and undelivered notes are saved with each session (`SavedNetworkState.notes`) and delivered after the restart.
Not fixable: a dialog left open when the DevTools connection drops or the gateway crashes; its tab is then left out as
silent and closed after the limit, and the note says a lost dialog may be the cause.
