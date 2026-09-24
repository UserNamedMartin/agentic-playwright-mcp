# agentic-playwright-mcp — notes for agents working on this repo

Read README.md first for what the project does. This file is about changing it.

## Layout

- `src/gateway.ts` — HTTP MCP server for one profile; sessions, subagent
  routing, tab links, cleanup sweeps.
- `src/session.ts` — one agent session = one Playwright MCP `BrowserBackend`
  with a patched `Context` (own tabs only, background tabs, no bringToFront).
- `src/browser.ts` — the shared browser over CDP: background tabs, window
  state, focus guard, `focusTab`.
- `src/internals.ts` — the only place that touches playwright-core internals.
- `src/subagents.ts` — Claude Code subagent detection from transcripts.
- `src/files.ts` — per-chat file folders and their weekly cleanup.
- `src/apps.ts` — MCP Apps tab-link widget; `src/tools.ts` — extra tools.
- `src/identity.ts` — `headersHelper` output (who is connecting).
- `src/launcher.ts`, `supervisor.ts`, `service.ts`, `profiles.ts`,
  `urlhandler.ts`, `macos.ts` — running profiles on the machine.
- `extension/` — companion extension (tab groups), loaded over CDP.
- `skill/SKILL.md` — the agent skill users install; keep it in sync with
  behavior changes.

## Rules

- `playwright-core` is pinned exactly. Upgrading means re-checking every
  internal name used in `internals.ts`, `session.ts` and `gateway.ts`
  (`BrowserBackend`, `Context` methods, `_tabs`, `_currentTab`, tool shapes).
  `verifyInternals()`/`verifyContext()` must keep failing loudly on mismatch.
- Never let agent work steal focus: new tabs via `SharedBrowser.newBackgroundPage`,
  never `context.newPage()` or `page.bringToFront()`. Only explicit user
  requests (`focusTab`) may raise the window.
- macOS: never talk to "System Events" from the gateway (it runs as a launchd
  service and blocks on an Automation permission prompt). Use `lsappinfo` and
  the link-handler applet (`agentic-browser://raise/<pid>`); background
  processes cannot activate other apps themselves.
- Never rewrite `~/Applications/Agentic Browser Links.app` unless its script
  changed: macOS App Management protection flags it.
- Keep personal data out of the repo: no user names, paths, profile names or
  ports of a particular machine.

## Checking changes

`npm run build`, then run a throwaway headless profile and the scripts in
`test/` (see test/README.md). Anything that opens windows or moves focus needs
a headed profile, and on someone's machine, their go-ahead first.
