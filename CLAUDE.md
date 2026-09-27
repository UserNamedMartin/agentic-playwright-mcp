# agentic-playwright-mcp — notes for agents working on this repo

Read README.md first for what the project does. This file is about changing it.

## Layout

- `src/gateway.ts` — HTTP MCP server for one profile; sessions, who owns which
  tab (`owners`), subagent routing, tab links, forks, permission and passkey
  requests, cleanup sweeps.
- `src/proxy.ts` — the isolation: every session's Playwright connects to the
  browser through its own DevTools endpoint here (a socket file, not a TCP
  port) and sees only its own tabs. The few browser-level commands are listed;
  anything else browser-wide is refused.
- `src/browser.ts` — the gateway's own raw DevTools connection: every tab and
  its owner, holding new tabs until their owner's Playwright has set them up,
  the gateway's page scripts (one binding, `bridgeScript`), background tabs,
  window state, focus guard, `focusTab`, the companion extension.
- `src/cdp.ts` — a raw CDP connection (used by browser.ts and proxy.ts).
- `src/session.ts` — one agent session: one call at a time with a timeout,
  notes, files, routes/offline/emulation kept across new threads, reconnects
  and restarts; starts, pings and ends the session's worker thread.
- `src/worker.ts` — the session's worker thread: a stock Playwright MCP
  `BrowserBackend` on its own Playwright connection through the proxy, and
  the session's tools. A thread that stops answering (a busy loop in
  run_code) is ended and started again; one idle for 10 minutes is ended.
- `src/netguard.ts` — sockets opened on an agent's behalf (everything in its
  worker thread) cannot reach the DevTools or gateway ports.
- `src/internals.ts` — the only place that touches playwright-core internals.
- `src/subagents.ts` — Claude Code subagent detection from transcripts.
- `src/files.ts` — per-chat file folders and their weekly cleanup.
- `src/apps.ts` — MCP Apps tab-link widget; `src/tools.ts` — extra tools
  (show_tab, emulate_device with per-tab settings kept by the session,
  permission); they reach the gateway through `ToolHost` (messages to the
  main thread).
- `src/scoped.ts` — cookie and storage-state tools act on the sites of the
  session's own tabs (the cookie jar is shared on purpose: logins); navigate /
  tabs refuse internal addresses before opening anything.
- `src/urls.ts` — addresses agents may not reach: every profile's DevTools
  and gateway ports on any loopback name (chrome:// stays open).
- `src/linktoken.ts` — tab links (/focus) are HMAC-signed.
- `src/permissions.ts`, `src/passkeys.ts`, `src/popups.ts` — page scripts
  (through the bridge in browser.ts) and the notes agents get.
- `src/identity.ts` — `headersHelper` output (who is connecting).
- `src/titles.ts` — current chat titles and forks (Claude desktop chat
  files); CLI `/rename` titles come from `subagents.ts`.
- `src/launcher.ts`, `supervisor.ts`, `service.ts`, `profiles.ts`,
  `urlhandler.ts`, `macos.ts` — running profiles on the machine.
- `extension/` — companion extension (tab groups, duplicating tabs for forked
  chats, muting tabs while the browser is out of sight), loaded over CDP.
  Bump `self.apmVersion` (and `extensionVersion` in groups.ts) when it
  changes: the gateway reloads an older copy it finds running.
- `skill/SKILL.md` — the agent skill users install; keep it in sync with
  behavior changes.

## Rules

- Isolation lives in `proxy.ts`, at the protocol level, and nowhere else.
  Each session runs Playwright MCP unchanged; do not patch Playwright to hide
  another chat's things (the previous design did, and every review round found
  another way around it). If a session can see or change something of another
  chat, find the protocol command or event that carried it and handle it in
  the proxy. Browser-level commands are an allowlist: a new one Playwright
  starts sending is refused until someone decides what it means for other
  chats.
- Agents' code never runs in the main thread: everything of a session's
  Playwright lives in its worker (worker.ts), so one agent cannot stall the
  gateway or other chats. Keep it that way; what the tools need from the
  gateway goes through `ToolHost` messages.
- `playwright-core` is pinned exactly. Upgrading means re-checking the names in
  `internals.ts` and the few internals worker.ts uses (`Context._tabs`,
  `_currentTab`, `_onPageCreated`, `routes()`/`addRoute`, the backend's
  `_disconnected`/`_disposed`), and running every self-contained test.
  `verifyInternals()`/`verifyContext()` must keep failing loudly on mismatch.
- The gateway's own connection is raw CDP, never Playwright: two Playwrights
  attached to one page answer each other's page bindings (checked: the chat's
  Playwright answered the gateway's binding with "not exposed").
- A new tab is held (waiting for the debugger) until its owner's Playwright
  has set it up; tabs the gateway opens for a page (links) open blank and go
  to their address once released (`createTarget({ navigateTo })`), since a tab
  created with its address starts loading before anyone can attach routes.
- Out of sight means window minimized AND app hidden: hidden apps leave no
  window thumbnail in the Dock, minimized windows keep new tabs from showing the
  app, and a hidden app's window cannot be un-minimized (unhide first).
- Never let agent work steal focus: the proxy creates every tab in the
  background and answers Page.bringToFront / Target.activateTarget itself.
  Only explicit user requests (`focusTab`) may raise the window.
- macOS: never talk to "System Events" from the gateway (it runs as a launchd
  service and blocks on an Automation permission prompt). Use `lsappinfo` and
  the link-handler applet (`agentic-browser://raise/<pid>`); background
  processes cannot activate other apps themselves.
- Never rewrite `~/Applications/Agentic Browser Links.app` unless its script
  changed: macOS App Management protection flags it.
- Tabs belong to sessions by CDP target id (`Gateway.owners`). The gateway
  must survive a dropped connection (it reconnects; sessions reconnect on their
  next call) and a restart (`sessions.json`) without closing anyone's tabs.
  A session's backend disposing itself because its connection dropped is not
  `browser_close`, and a context the agent's code closed is (see
  `AgentSession._callTool`).
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
- Tests must not write into the user's folders: a test that starts its own
  browser gives it a default download folder in its scratch home (Chrome
  falls back to it whenever a DevTools client that set a download folder
  disconnects; without it, test downloads landed in the user's Downloads).
  Profiles started by the launcher get `browser-downloads` next to their data.
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

## Isolation model (read before touching sessions, the proxy or tools)

Goal set by the user: every agent works as if it had the browser to itself
(no accidental seeing or affecting other chats), with all upstream Playwright
MCP functionality. It is not a security boundary against deliberately
malicious code (run_code runs in a thread of the gateway process; any local
process can reach the DevTools port).

How it holds:
- Each session's Playwright has its own connection, through the proxy, which
  attaches it only to the session's tabs. So everything Playwright scopes to
  its browser context is the session's by construction: pages, events, routes
  and offline mode (per tab in Chromium, including popups' first loads), init
  scripts, bindings, extra headers, geolocation, clock, the recorder, tracing,
  video, timeouts, CDP sessions.
- Tabs belong to sessions by target id: tabs a session creates, popups by
  opener (Chrome reports it even for noopener), link tabs the gateway opens
  (told to Playwright with their opener), fork copies.
- Shared on purpose, as a browser is: the cookie jar and site storage (logins),
  site permissions, chrome:// pages (the skill tells agents they act on the
  whole browser). The proxy shows a session only the cookies of its own sites
  (Storage.getCookies filtered, "clear all" clears its sites' only); the cookie
  tools can reach another site when the agent names its domain.
- Refused as browser-wide: other targets, browser contexts, window bounds,
  resetting permissions, the browser's cache and all-cookie commands, service
  workers, downloads behavior (each download is moved to its session's
  folder), and every browser-level command not on the proxy's list.
- The DevTools port and the gateway's pages: the proxy refuses navigations
  there and takes frames that land there (redirects, scripts) back to
  about:blank; netguard.ts refuses sockets opened on an agent's behalf. A
  context whose tabs were sent to such an address cannot save its storage
  state from run_code afterwards (Playwright would visit that origin again).
- The status page is written into the pinned home tab over DevTools, never
  served over HTTP; `/` shows a note. Tab links are signed. The gateway answers
  only local MCP clients (no foreign Host, no Origin).
- A call given up at its timeout cannot change the current tab (callState
  AsyncLocalStorage guard on `context._currentTab`).
- Routes (from browser_route), offline and emulation survive reconnects and
  restarts (`sessions.json`); video/trace/recording/code routes are reported
  as lost.

History: the first design shared one Playwright connection among all sessions
and hid other chats by patching Playwright MCP (a membrane around run_code,
shared recorder and tracing, owner checks on routes). Five review rounds each
found another 12-14 ways around it; it was replaced by the proxy (2026-09-27).

## Commits

One logical change per commit: a fix and its test, or one topic. Commit
each as soon as it is green, before starting the next, even when fixes touch
the same files; every commit builds and passes its tests. Never batch a
review round's fixes into one commit.

## Calling it done

Green tests only cover what their author thought of. Before a change that
touches isolation, sessions or the shared browser is called done, try to break
it: scratch repros on a throwaway headless gateway, with two chats. What that
finds gets a failing test and a fix; report what was checked, not "all
covered". New leak paths go into `canary.mjs`, which searches everything one
chat gets for another chat's secret.

## Checking changes

`npm run build`, then `node test/reconnect.mjs`, `node test/permissions.mjs`,
`node test/passkeys.mjs`, `node test/forks.mjs`, `node test/downloads.mjs`, `node test/hangs.mjs`, `node test/matrix.mjs`, `node test/robustness.mjs`, `node test/reconnect-stall.mjs`, `node test/leaks.mjs`, `node test/config.mjs` and `node test/canary.mjs`
(self-contained, headless; headless Chrome grants some permissions by itself,
so check permission changes in a headed profile too; `APM_PROXY_DEBUG=1` logs
every command the proxy refuses)
and a throwaway headless profile with the other scripts in `test/` (see
test/README.md). Anything that opens windows or moves focus needs
a headed profile, and on someone's machine, their go-ahead first:
`node test/headed.mjs` covers the fork copies and passkeys that way.
