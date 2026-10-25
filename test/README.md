# Development test scripts

Two kinds of scripts:

- self-contained pass/fail tests (`canary`, `matrix`, `robustness`,
  `reconnect-stall`, `leaks`, `config`, `hangs`, `reconnect`, `permissions`,
  `passkeys`, `forks`, `downloads`, `paths`, `front`, `headed`): each starts its own browser, gateway and scratch
  `AGENTIC_PLAYWRIGHT_HOME`, prints one line per check and exits non-zero on
  failure. All but `headed` are headless; `headed` shows a window (macOS).
- scripts used while developing the gateway: they talk to a running gateway
  (or its browser) and print what they observed.

For the second kind, start a throwaway headless profile so nothing appears on
screen:

```sh
export AGENTIC_PLAYWRIGHT_HOME=/tmp/apm-test
node dist/cli.js profile add test --headless --port 18931 --cdp-port 19231
node dist/cli.js start test
```

| Script | Checks |
|---|---|
| `reconnect.mjs [browser]` | self-contained (own headless browser, gateway and scratch home), pass/fail: tabs survive a dropped DevTools connection and a gateway restart, lazy session start, group titles follow `/rename`, same titles numbered, an older extension is reloaded, hidden tabs are muted |
| `permissions.mjs [browser]` | self-contained, pass/fail: permission requests are reported, answered with `browser_permission`, held ones wait, unanswered ones time out |
| `passkeys.mjs [browser]` | self-contained, pass/fail: passkey requests in a browser nobody can see are cancelled at once and reported; passkey autofill is left alone |
| `hangs.mjs [browser]` | self-contained, pass/fail: a cancelled call and a call past its timeout free the session queue at once; a raised `timeout` is honored; a call that waited behind another says so; given-up or cancelled `run_code` stops; after a reconnect a page stuck in a script is left out (and closed after the limit, `AGENTIC_SILENT_TAB_CLOSE_MS`), a page busy for a while comes back, a dialog left open is dismissed, a page with a stuck out-of-process frame stays |
| `matrix.mjs [browser]` | self-contained, pass/fail: every tool across two sessions — works at all, does not reach the other session, leaves nothing behind when its chat ends |
| `canary.mjs [browser]` | self-contained, pass/fail: chat B's pages carry a secret; chat A tries every known way to see or touch B (tools, run_code's context, raw CDP sessions, events, cookies, status page, internal addresses by every path, recorder, tracing) and every text and file A gets is searched for it; no call leaves a tab that is not A's; A's own popups, new pages and first-load routes work |
| `downloads.mjs [browser]` | self-contained, pass/fail: small downloads that finish at once reach their chat from the main frame, a same-site iframe, a cross-site iframe, a hidden iframe removed at once and a tab of their own (target=_blank, window.open), with other chats' tabs open; a download in nobody's tab goes to the browser's own downloads folder; nothing stays in the gateway's download folder |
| `paths.mjs [browser]` | self-contained, pass/fail: saved screenshots, snapshots, evaluate results and downloads are named by absolute path; the code Playwright ran, run_code and evaluate results and page text in a snapshot keep file names that exist in the files folder |
| `front.mjs [browser]` | self-contained, pass/fail: while nobody can see the browser (headless counts) the status page stays in front of its window through new tabs, target=_blank, window.open, cross-site navigation, a fork's copies, closing the front tab, another chat's tabs and a gateway restart |
| `zoom-emulation.mjs [browser]` | self-contained, headless regression: at 50% Chrome site zoom, CDP device emulation keeps Playwright click coordinates correct; reapplying at 100% zoom also works |
| `zoom-gateway.mjs [browser]` | self-contained, headless MCP integration: the companion extension reports a tab's site zoom, device emulation clicks correctly at 50%, and the worker refreshes scale after navigation to a 100% host |
| `robustness.mjs [browser]` | self-contained, pass/fail: one session's failed download, stuck page, busy loop in code or given-up call does not reach the others; the gateway survives the browser connection dropping during a download; only local MCP clients get a session |
| `reconnect-stall.mjs [browser]` | self-contained, pass/fail: a reconnect attempt whose setup the browser never answers is given up and retried; waiting calls get answered (about a minute) |
| `leaks.mjs [browser]` | self-contained, pass/fail (gateway in-process): a 120 MB transcript is read without blocking the process, remembered tool calls are bounded; closed tabs, ended chats' proxy clients, connections, tabs and title files are forgotten; a tab created as its chat ends is closed |
| `config.mjs [browser]` | self-contained, pass/fail: a Playwright MCP config file (`--config`) and `PLAYWRIGHT_MCP_*` variables reach the gateway: initScript, allowed/blocked origins, testIdAttribute, secrets, timeouts, default capabilities |
| `screenshot-diagnostics.mjs` | pass/fail with a fake clock: CDP screenshot sent/reply, pending command, connection close and error redaction; `matrix.mjs` checks the live hook in a headless gateway |
| `subagent-transcripts.mjs [browser]` | self-contained, pass/fail: subagents get their own session when the chat's CLI session id appears after connect or changes, the header is stale, or the config dir is only in the agent's environment; the transcript line is written after the call starts (0.9 s, 2.5 s, parallel subagents, a subagent idle for 30 min), as Claude Code does; a call no transcript names is refused (`AGENTIC_TRANSCRIPT_WAIT_MS` shortens the wait) |
| `titles.mjs` | self-contained, no browser: a desktop chat's title and CLI session id come from `<account>/<org>/<id>.json`, not from a newer `waiting-input/<id>.json` |
| `forks.mjs [browser]` | self-contained, pass/fail: a chat forked in the Claude desktop app (fake chat files via `AGENTIC_CLAUDE_APP_SUPPORT`) starts with copies of the original chat's tabs, history and sessionStorage included; the original keeps its own |
| `gated-update.mjs` | macOS, self-contained, headless, a few minutes (each build waits for the system's malware scan): after the source browser's version changes, `updateGatedBrowser` builds the new version in its own folder, moves profiles to it, keeps a copy a browser still runs from and removes it once nothing does, refuses a concurrent update and takes over a lock whose process is gone; with a scratch keychain: a locked one stops the build before codesign (which would ask in a dialog), a saved password unlocks it |
| `show-gate.mjs [--ungated]` | macOS, self-contained, **shows a window** (go-ahead first): builds an ad hoc gated copy (mock keychain), then pages call `window.open` (blob and popup window), submit a form with `target=_blank`, follow a `rel=opener` link and call `window.focus()` while the browser is out of sight; it must never be frontmost or unhidden and the focus guard must have nothing to undo; `browser_show_tab` must still show it, with the tab's window un-minimized and still in view 4.5 s later (past the focus guard), and so must a Dock click (a reopen event via `open -a`, gated copy only), with no new empty window. `--ungated` runs the same on stock Chrome and is expected to fail |
| `headed.mjs [browser]` | macOS, self-contained, **shows a window near the end** (run it only with the go-ahead of whoever is at the screen), pass/fail: copying a fork's tabs keeps the hidden browser hidden, minimized and in the background; tabs are muted while hidden and not while the window is in front; passkey requests are cancelled while hidden and reach the browser's (on macOS the system's) passkey prompt once the window is in front. A tab shown by a tab link does not stay in front once the window is minimized again (the status page does): it still takes screenshots and runs animation frames after a cross-site navigation; restoring the window by hand brings it back to the front, a tab link's own tab wins over it. `SCREENSHOT=<file.png>` saves the screen with that prompt |
| `e2e-client.mjs <mcp url> <session id> <title>` | one session: navigate, click, second tab, isolation, tab link, device emulation. Run several in parallel for concurrency |
| `features.mjs <mcp url>` | `target=_blank` links become background tabs; manual subagent sessions |
| `subagents.mjs <mcp url>` | several callers in one session, each with its own `tab` |
| `auto-subagents.mjs <mcp url> <scratch dir>` | automatic subagent detection from fake Claude Code transcripts |
| `apps.mjs <mcp url> <cdp url>` | MCP Apps tab-link widget, rendered in a fake host page |
| `files.mjs <mcp url>` | run from a scratch dir: screenshots, snapshots and downloads land in the session's files folder, not in the cwd |
| `inspect.mjs <cdp url>` | prints the browser's tab groups and tabs |
| `focus-timeline.mjs <cdp url> <link> [ms]` | macOS, headed profile: front app and window state after opening a link (set `OPEN_ARGS` to pass flags to `open`) |

`HOLD=<ms>` keeps a client connected at the end so you can inspect the browser.
