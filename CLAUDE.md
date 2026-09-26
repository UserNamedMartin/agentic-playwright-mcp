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
- `src/apps.ts` — MCP Apps tab-link widget; `src/tools.ts` — extra tools
  (show_tab, emulate_device with per-tab settings kept by the session,
  permission).
- `src/scoped.ts` — replacements of stock tools that would act on the whole
  shared context: cookies/storage scoped to the session's sites, network
  state, tracing/recording entry points, run_code (through isolation.ts),
  navigate/tabs URL checks.
- `src/isolation.ts` — the membrane `browser_run_code_unsafe` gets: every
  Playwright object reachable from `page` is wrapped; context views show only
  the session's tabs and events; context-wide members are scoped or refused.
- `src/recording.ts` — recorder and tracing shared by sessions: one recorder
  / one trace for all, each session gets only its own (trace cut into chunks,
  filtered by calls tagged per session with AsyncLocalStorage and by page).
- `src/urls.ts` — addresses agents may not reach: every profile's DevTools
  and gateway ports on any loopback name (chrome:// stays open).
- `src/linktoken.ts` — tab links (/focus) are HMAC-signed.
- `src/config.ts` — Playwright MCP config file / env options applied once to
  the shared context.
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
  SIGKILL. `browser_annotate` opens the Playwright Dashboard (its own visible
  browser, which outlives the gateway) and `browser_show_tab` raises the
  window: tests do not call them.
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

## Isolation model (read before touching sessions or tools)

Goal set by the user: every agent works as if it had the browser to itself
(no accidental seeing or affecting other chats), with all upstream Playwright
MCP functionality. It is not a security boundary against deliberately
malicious code (run_code runs in the gateway process; any local process can
reach the DevTools port).

How it holds, and what is decided on purpose:
- Tabs belong to sessions; popups by opener (Chrome's target events for a
  popup's first request, see `browser.ts` popupOpener).
- Routes and offline mode are context-level routes with an owner check
  (reach popups' first load). Cost, accepted: while any session has one,
  Playwright disables the HTTP cache browser-wide.
- Cookie / storage tools act on the sites of the session's own tabs; an
  explicit `domain` reaches another site.
- Tracing and the recorder run once for everyone; each session gets only its
  own. While anyone traces, Playwright writes every tab's data to a temp dir
  (`agentic-trace-<pid>-*`, removed at stop / next start).
- The status page is written into the pinned home tab over DevTools, never
  served over HTTP; `/` shows a note. Tab links are signed.
- Every frame of a session that lands on a DevTools/gateway port (redirect,
  script, binding) is sent to about:blank (`session.ts` _leaveInternal);
  run_code requests follow redirects hop by hop with the same check.
- chrome:// pages are open to agents on purpose (the skill tells them they
  act on the whole browser). `browser_annotate` is removed; `vision` and
  `pdf` capabilities are on, `config` off (it prints secrets).
- A call given up at its timeout cannot change the current tab (callState
  AsyncLocalStorage guard on `context._currentTab`).
- Routes (from browser_route), offline and emulation survive reconnects and
  restarts (`sessions.json`); video/trace/recording/code routes are reported
  as lost.

Review history: five rounds of independent critic agents (commit messages
from 9fca4ea on record every finding and fix). Round 5's fixes (afdc0a6 ..
24e505b) were not yet reviewed by a sixth round. Known open: traces over
512 MB cannot be filtered (one string); a popup's first request gets no
routes when two chats open popups within ~3 s (safe side).

## Commits

One logical change per commit: a fix and its test, or one topic. Commit
each as soon as it is green, before starting the next, even when fixes touch
the same files; every commit builds and passes its tests. Never batch a
review round's fixes into one commit.

## Calling it done

Green tests only cover what their author thought of. Before a change that
touches isolation, sessions or the shared browser is called done, an agent
that did not write it reviews it with the aim of breaking it (see how the
earlier review rounds were briefed: what changed, what is accepted, confirm
findings with scratch repros on a throwaway headless gateway). What it finds
gets a failing test and a fix; report what was checked, not "all covered".
New leak paths go into `canary.mjs`, which searches everything one chat gets
for another chat's secret.

## Checking changes

`npm run build`, then `node test/reconnect.mjs`, `node test/permissions.mjs`,
`node test/passkeys.mjs`, `node test/forks.mjs`, `node test/hangs.mjs`, `node test/matrix.mjs`, `node test/robustness.mjs`, `node test/reconnect-stall.mjs`, `node test/leaks.mjs`, `node test/config.mjs` and `node test/canary.mjs`
(self-contained, headless; headless Chrome grants some permissions by itself,
so check permission changes in a headed profile too)
and a throwaway headless profile with the other scripts in `test/` (see
test/README.md). Anything that opens windows or moves focus needs
a headed profile, and on someone's machine, their go-ahead first:
`node test/headed.mjs` covers the fork copies and passkeys that way.
