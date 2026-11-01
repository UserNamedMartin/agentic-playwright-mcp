---
status: open
area: sessions
found: 2026-10-28
filed: 2026-11-01
reproducible: yes (under heavy machine load; see Steps)
suspect: gateway
fixed-in:
---

# Under heavy machine load the gateway ends a healthy session thread as "stuck", and the reconnect then times out

## Symptoms

An agent's plain `browser_navigate` came back with

> browser_navigate never gave the browser session a chance to answer (code that never yields, such as a busy loop in
> browser_run_code_unsafe), so the session was restarted.

although no agent code was running. Every following call of that session (`browser_navigate`, `browser_tabs`,
`browser_evaluate`) failed after 15 s with `browserType.connectOverCDP: Timeout 15000ms exceeded`, once also with
`proxy: <session>: Could not connect to ws://127.0.0.1:<cdp-port>/devtools/browser/<id> within 15 s`. Calls worked
again once the load was gone.

## Environment

Claude Code desktop, main chat, one or two chats using the browser. Both times the machine was under heavy CPU load:
2026-10-28 ~22:41 UTC a video render (6 headless browser workers plus H.264 encoding, load average ~40);
2026-11-01 16:47–16:56 UTC 40 busy test processes (load average 60–380).

## Steps to reproduce

1. Put the machine under CPU load well above its core count (e.g. 40 busy `node` processes on 10 cores).
2. From a chat, `browser_navigate` to any page in a new or idle session.
   - Expected: the page opens, slower.
   - Actual: after 10 s, "never gave the browser session a chance to answer"; the thread is ended.
3. Call `browser_tabs` `list` while the load lasts.
   - Expected: the session reconnects, slower.
   - Actual (sometimes): `connectOverCDP: Timeout 15000ms exceeded`, repeated on every call until the load ends.

Without the load nothing of this happens. A throwaway gateway started from a shell (normal priority) did NOT reproduce
it under the same load; the live service did (step 2, 2026-11-01 16:48:29Z).

## Evidence

- `profiles/<profile>/gateway.log` 2026-10-28 22:41:45Z `… browser thread stopped answering during browser_navigate;
  ending it`, then 22:42:27Z and 22:43:14Z `connectOverCDP: Timeout 15000ms exceeded`; the chat's transcript shows a
  render with load ~40 running at the time.
- 2026-11-01 16:48:29Z (another profile, under the test load) and 16:51:31Z, 16:53:12Z, 16:53:58Z, 16:55:28Z (second
  profile, another chat, same load): the same sequence plus the proxy's 15 s connect failure to the browser.
- `ps -o pri` of the launchd-run gateways: 20 (utility); a process started from a shell: 31. The service plist has no
  `ProcessType`, which launchd documents as "light resource limits, throttling its CPU usage and I/O".
- Renderers of agent tabs often run at priority 4 even with `--disable-renderer-backgrounding`; under the test load a
  tab answered `Page.getFrameTree` in up to 2.9 s (the proxy's limit is 2 s).

## Cause

Two parts (hypothesis backed by the evidence above):

1. `AgentSession._send` (src/session.ts) decides "stuck" from wall-clock time since the last pong (10 s). A thread
   that is starved of CPU, or a main thread that did not run to read the pongs, looks the same as a busy loop. The
   check cannot tell "the worker's event loop never yielded" from "nobody got CPU".
2. The gateway runs as a launchd job without `ProcessType`, so macOS throttles it below the user's own work; under
   load its threads (main, workers, proxy) starve, and wall-clock timeouts (Playwright's 15 s connect, the proxy's
   15 s browser connect) expire while the process barely ran.

## Suggested fix

1. Judge "stuck" by the worker's event loop, not by the clock alone: `worker.performance.eventLoopUtilization()` —
   a busy loop shows no idle time growing (checked on Node 20: busy +0 ms idle per second, idle worker +1000 ms);
   and a tick of the pinger that itself fired late means the gateway did not run, so it must not count against the
   worker. Test: suspend the throwaway gateway process (SIGSTOP 12 s, SIGCONT) during a waiting call in
   `test/hangs.mjs`; the call must finish normally, and the existing busy-loop case must still end its thread.
2. Write `ProcessType` `Interactive` into the service plist (src/service.ts), so the gateway is scheduled like the
   apps it serves. Check after installing: `ps -o pri` of the gateway is 31, not 20.

## Workaround

Repeat the call after the load ends. Avoid heavy machine-wide jobs while agents use the browser.
