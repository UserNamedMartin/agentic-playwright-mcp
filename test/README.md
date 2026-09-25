# Development test scripts

Two kinds of scripts:

- self-contained pass/fail tests (`reconnect`, `permissions`, `passkeys`,
  `forks`, `headed`): each starts its own browser, gateway and scratch
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
| `reconnect.mjs [browser]` | self-contained (own headless browser, gateway and scratch home), pass/fail: tabs survive a dropped DevTools connection and a gateway restart, lazy session start, group titles follow `/rename`, same titles numbered |
| `permissions.mjs [browser]` | self-contained, pass/fail: permission requests are reported, answered with `browser_permission`, held ones wait, unanswered ones time out |
| `passkeys.mjs [browser]` | self-contained, pass/fail: passkey requests in a browser nobody can see are cancelled at once and reported; passkey autofill is left alone |
| `hangs.mjs [browser]` | self-contained, pass/fail: a cancelled call and a call past its timeout free the session queue at once; a raised `timeout` is honored; a call that waited behind another says so |
| `matrix.mjs [browser]` | self-contained, pass/fail: every tool across two sessions — works at all, does not reach the other session, leaves nothing behind when its chat ends |
| `robustness.mjs [browser]` | self-contained, pass/fail: one session's failed download, stuck page or given-up call does not reach the others; the gateway survives the browser connection dropping during a download |
| `reconnect-stall.mjs [browser]` | self-contained, pass/fail: a reconnect attempt whose setup the browser never answers is given up and retried; waiting calls get answered (about a minute) |
| `forks.mjs [browser]` | self-contained, pass/fail: a chat forked in the Claude desktop app (fake chat files via `AGENTIC_CLAUDE_APP_SUPPORT`) starts with copies of the original chat's tabs, history and sessionStorage included; the original keeps its own |
| `headed.mjs [browser]` | macOS, self-contained, **shows a window near the end** (run it only with the go-ahead of whoever is at the screen), pass/fail: copying a fork's tabs keeps the hidden browser hidden, minimized and in the background; passkey requests are cancelled while hidden and reach the browser's (on macOS the system's) passkey prompt once the window is in front. `SCREENSHOT=<file.png>` saves the screen with that prompt |
| `e2e-client.mjs <mcp url> <session id> <title>` | one session: navigate, click, second tab, isolation, tab link, device emulation. Run several in parallel for concurrency |
| `features.mjs <mcp url>` | `target=_blank` links become background tabs; manual subagent sessions |
| `subagents.mjs <mcp url>` | several callers in one session, each with its own `tab` |
| `auto-subagents.mjs <mcp url> <scratch dir>` | automatic subagent detection from fake Claude Code transcripts |
| `apps.mjs <mcp url> <cdp url>` | MCP Apps tab-link widget, rendered in a fake host page |
| `files.mjs <mcp url>` | run from a scratch dir: screenshots, snapshots and downloads land in the session's files folder, not in the cwd |
| `inspect.mjs <cdp url>` | prints the browser's tab groups and tabs |
| `focus-timeline.mjs <cdp url> <link> [ms]` | macOS, headed profile: front app and window state after opening a link (set `OPEN_ARGS` to pass flags to `open`) |

`HOLD=<ms>` keeps a client connected at the end so you can inspect the browser.
