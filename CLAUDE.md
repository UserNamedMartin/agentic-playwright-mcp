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
- `src/permissions.ts` — permission requests: page hooks, notices, names.
- `src/passkeys.ts` — passkey (WebAuthn) requests: page hook, notice.
- `src/identity.ts` — `headersHelper` output (who is connecting).
- `src/titles.ts` — current chat titles and forks (Claude desktop chat
  files); CLI `/rename` titles come from `subagents.ts`.
- `src/launcher.ts`, `supervisor.ts`, `service.ts`, `profiles.ts`,
  `urlhandler.ts`, `macos.ts` — running profiles on the machine.
- `extension/` — companion extension (tab groups, duplicating tabs for forked
  chats), loaded over CDP.
- `skill/SKILL.md` — the agent skill users install; keep it in sync with
  behavior changes.

## Rules

- `playwright-core` is pinned exactly. Upgrading means re-checking every
  internal name used in `internals.ts`, `session.ts` and `gateway.ts`
  (`BrowserBackend`, `Context` methods, `_tabs`, `_currentTab`, tool shapes).
  `verifyInternals()`/`verifyContext()` must keep failing loudly on mismatch.
- Out of sight means window minimized AND app hidden: hidden apps leave no
  window thumbnail in the Dock, minimized windows keep new tabs from showing the
  app, and a hidden app's window cannot be un-minimized (unhide first).
- Never let agent work steal focus: new tabs via `SharedBrowser.newBackgroundPage`,
  never `context.newPage()` or `page.bringToFront()`. Only explicit user
  requests (`focusTab`) may raise the window.
- macOS: never talk to "System Events" from the gateway (it runs as a launchd
  service and blocks on an Automation permission prompt). Use `lsappinfo` and
  the link-handler applet (`agentic-browser://raise/<pid>`); background
  processes cannot activate other apps themselves.
- Never rewrite `~/Applications/Agentic Browser Links.app` unless its script
  changed: macOS App Management protection flags it.
- Tabs belong to sessions by CDP target id (`AgentSession.targets`), not by
  `Page`: pages also emit "close" when the browser connection drops, only
  `Target.targetDestroyed` means a tab really closed. The gateway must survive
  a dropped connection (it reconnects) and a restart (`sessions.json`) without
  closing anyone's tabs.
- Tests must not change `HOME`: on macOS the browser then looks for its
  keychain there and the system shows the user a "Keychain Not Found" dialog.
  Point the gateway at fake files with variables such as
  `AGENTIC_CLAUDE_APP_SUPPORT` instead.
- Tests must never put anything on the user's screen: quitting Chrome while a
  download runs shows a "Download is in progress" prompt even for a headless
  browser, so tests end their downloads and kill their own browser with
  SIGKILL.
- Keep personal data out of the repo: no user names, paths, profile names or
  ports of a particular machine.

## Fixing bugs

Every bug fix comes with a test that fails without the fix and passes with it,
kept in `test/` (extend an existing self-contained script, such as
`matrix.mjs` for anything one session's tools do to another, or add one).
Only typos, docs, and behavior that can only be checked in a headed profile by
someone at the screen are exempt; for those, say in the commit how it was
checked by hand. Anything upstream assumes about owning the whole browser
context (routes, tracing, video, cookies, storage, network state, process-wide
listeners) needs a two-session check in `matrix.mjs`.

## Checking changes

`npm run build`, then `node test/reconnect.mjs`, `node test/permissions.mjs`,
`node test/passkeys.mjs`, `node test/forks.mjs`, `node test/hangs.mjs`, `node test/matrix.mjs`, `node test/robustness.mjs`, `node test/reconnect-stall.mjs`, `node test/leaks.mjs` and `node test/config.mjs`
(self-contained, headless; headless Chrome grants some permissions by itself,
so check permission changes in a headed profile too)
and a throwaway headless profile with the other scripts in `test/` (see
test/README.md). Anything that opens windows or moves focus needs
a headed profile, and on someone's machine, their go-ahead first:
`node test/headed.mjs` covers the fork copies and passkeys that way.
