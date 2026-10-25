---
status: fixed
area: sessions
found: 2026-10-25
filed: 2026-10-25
reproducible: yes
fixed-in: c7b70ee (test/hangs.mjs, "run_code given up at its timeout stops running", "cancelled run_code stops running")
---

# browser_run_code_unsafe keeps running after the gateway gave it up

## Symptoms

The main agent ran a polling loop in `browser_run_code_unsafe` (fetching records from a site where the browser was logged in, one every
1.5 s). The call came back with "did not finish within 115 s and was given up". The loop went on in the session's
thread: the next calls of the session waited behind it ("This call waited 178 s for your previous call"), and it kept
hitting the site until the site rate-limited the logged-in account (HTTP 429 "Too Many Attempts") for about half an hour.
A subagent's run_code later did the same until its thread stopped answering pings.

## Environment

Claude Code desktop, one chat plus background subagents, 2026-10-25 17:28–18:03 UTC.

## Steps to reproduce

`node test/hangs.mjs`: a run_code loop that increments a page counter every 100 ms, called with `timeout: 2`; then
the counter is read twice 1.5 s apart. Same with a cancelled call.

- Expected: the counter stops after the call is given up / cancelled.
- Actual (before the fix): it keeps growing (24 → 43, 78 → 114).

## Evidence

`profiles/<profile>/gateway.log`: `browser_run_code_unsafe from <chat> gave up after 115 s` (17:30:32Z); the site
answered 429 to every request from the account until ~18:24Z.

## Cause

`AgentSession._callWithTimeout` (`src/session.ts`) only marks a given-up call `abandoned` and moves the queue on; the
agent's code keeps running in the worker thread. Upstream Playwright MCP has no call timeout at all, so this
"given up but still running" state exists only because of the gateway.

## Fix

c7b70ee: a given-up or cancelled `browser_run_code_unsafe` retires the thread, as code that never yields already did
(tabs stay; the next call starts a new thread; routes added from code, recordings, traces and video end, with the
usual notes). The result says the code was stopped. The skill says so too.
