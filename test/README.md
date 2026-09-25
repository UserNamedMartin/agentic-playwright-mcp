# Development test scripts

Scripts used while developing the gateway. Each one talks to a running gateway
(or its browser) and prints what it observed; none of them is an automated
pass/fail suite yet.

Start a throwaway headless profile so nothing appears on screen:

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
| `e2e-client.mjs <mcp url> <session id> <title>` | one session: navigate, click, second tab, isolation, tab link, device emulation. Run several in parallel for concurrency |
| `features.mjs <mcp url>` | `target=_blank` links become background tabs; manual subagent sessions |
| `subagents.mjs <mcp url>` | several callers in one session, each with its own `tab` |
| `auto-subagents.mjs <mcp url> <scratch dir>` | automatic subagent detection from fake Claude Code transcripts |
| `apps.mjs <mcp url> <cdp url>` | MCP Apps tab-link widget, rendered in a fake host page |
| `files.mjs <mcp url>` | run from a scratch dir: screenshots, snapshots and downloads land in the session's files folder, not in the cwd |
| `inspect.mjs <cdp url>` | prints the browser's tab groups and tabs |
| `focus-timeline.mjs <cdp url> <link> [ms]` | macOS, headed profile: front app and window state after opening a link (set `OPEN_ARGS` to pass flags to `open`) |

`HOLD=<ms>` keeps a client connected at the end so you can inspect the browser.
