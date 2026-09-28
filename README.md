# agentic-playwright-mcp

Many AI agents, one real browser, one tab group each.

An MCP server that lets any number of agent sessions (Claude Code chats,
their subagents, Codex, other MCP clients) work in parallel in **one normal,
logged-in browser**. Every session gets its own Chrome tab group and only sees
its own tabs, while all of them share the browser's cookies and logins. The
browser runs hidden in the background and does not steal focus.

Under the hood every session runs the stock
[Playwright MCP](https://github.com/microsoft/playwright-mcp) tools (snapshots,
clicks, forms, JavaScript, network, console, screenshots, downloads, video,
tracing, ...), so agents use the tools they already know.

> Unofficial project, not affiliated with or endorsed by Microsoft.

## Why

Stock Playwright MCP is built for one agent at a time:

- two sessions pointed at the same browser act on the same tabs;
- new tabs open in the foreground and un-minimize the window, stealing focus;
- the persistent profile is keyed by the working directory, so logins seem to
  "expire" whenever an agent works from another folder;
- the usual workaround, one isolated browser per session, means no logins.

## Features

- **Profiles**: named, persistent browsers (say `work` and `personal`), each
  with its own logins, port and gateway, independent of any project folder.
- **A real browser**: your installed Chrome, Brave, Edge or Chromium, headed,
  so sites treat it like any other browser.
- **Isolation**: each session sees and controls only the tabs it opened, plus
  popups those tabs open, and everything Playwright MCP does is the session's
  own (routes, scripts, recordings, traces); see "Things to know".
- **One agent cannot stall the others**: each session runs in a thread of its
  own; code stuck in a busy loop gets only that session restarted, with its
  tabs kept.
- **Tab groups**: each session's tabs sit in a named, colored tab group,
  created when the chat first uses the browser. The group is titled after the
  chat and follows renames (Claude desktop app chats, and `/rename` in the
  Claude Code CLI); chats with the same title are numbered.
- **Forked chats keep their tabs**: a chat forked in the Claude desktop app
  starts with copies of the original chat's tabs, made like the browser's
  "Duplicate" command (history and sessionStorage included); the originals stay
  with the original chat.
- **Subagents, automatically**: Claude Code subagents are recognized and get
  their own tab group, running in parallel. Other clients call
  `browser_subagent_start`.
- **Quiet**: the browser starts without a window and stays out of sight
  (minimized and hidden, so no window thumbnail in the Dock); tabs open in the
  background; links that open new tabs become background tabs. Minimizing the
  window hides the browser; closing it gets a fresh hidden window. Its tabs
  are muted while you cannot see it (pages do not notice) and play sound again
  when the window is in front. While the window is out of sight the status
  page is the tab in front and agents' tabs stay behind it, because Chrome
  stops drawing the front tab of a minimized window (its screenshots and
  animation frames stall). The extension holds it there for as long as the
  window is out of sight, whatever brings another tab forward (a fork's copy,
  window.open, Chrome picking a neighbour when the front tab closes); only a
  tab link lets a tab through. The tab you had in front comes back when the
  window is in view again.
- **Tab links**: `browser_tab_link` gives the agent a link to put in the chat;
  clicking it opens the window on that tab (for logins, captchas, review).
- **Tabs survive hiccups**: when the connection to the browser drops (macOS
  drops it when the display turns off) the gateway reconnects and every chat
  keeps its tabs; a restarted gateway gets them back too.
- **Cleanup**: a session's tabs close when its client process exits or after a
  day without browser use.
- **Permission requests reach the agent**: nobody sees permission prompts in a
  hidden browser, so pages used to wait forever. The browser refuses to prompt;
  requests show up in the agent's tool results and the agent answers them with
  `browser_permission` (camera, microphone, location and notifications wait
  for the answer).
- **Passkey requests do not hang**: a passkey prompt in the hidden browser has
  nobody to answer it, so sites used to wait until they timed out. While nobody
  can see the browser, passkey requests are cancelled at once (the site then
  offers its other ways to sign in) and the agent is told; with the window in
  front (after a tab link) they go through to the browser as usual.
- **Per-tab device emulation**: `browser_emulate_device` emulates a phone in
  one tab without affecting other agents.
- **Dock badges** (macOS): each profile's browser icon carries a short label
  (up to 3 characters, e.g. `WRK`, `P`) in a colored tag, so several agent
  browsers are easy to tell apart.
- **Files stay out of your projects**: screenshots, snapshots, downloads,
  videos and traces go to a per-chat folder, deleted after a week without use.

## Requirements

- Node.js 20 or newer.
- Chrome, Brave, Edge or Chromium.
- macOS for the background service, window handling and tab links. The gateway
  itself is plain Node and should run on Linux and Windows too, but that is not
  tested yet.

## Quick start

```sh
npm install -g agentic-playwright-mcp
agentic-playwright-mcp setup work
```

`setup` creates the profile `work`, starts its browser and gateway in the
background at every login (launchd), installs the tab-link handler, and prints
the MCP entry for your client. For Claude Code it prints a ready command:

```sh
claude mcp add-json -s user browser '{"type":"http","url":"http://127.0.0.1:8931/mcp","headersHelper":"… identity"}'
```

The `headersHelper` tells the gateway which chat is connecting, so tab groups
get the chat's title (and follow renames), a resumed chat gets its tabs back, and tabs close as soon
as the chat's process exits. Without it every MCP connection is simply its own
session.

Then teach your agents how to use it: copy [`skill/`](skill) into your agent's
skills directory (for Claude Code, `~/.claude/skills/agentic-browser`).

### Logging in

The profile starts empty. Sign in to sites as you need them: open the window
with `agentic-playwright-mcp open work`, or click a tab link an agent gives you.
Some sites (Google in particular) may refuse to sign in while the browser is
under remote control; then run `agentic-playwright-mcp login work`, which opens
the same profile as a plain browser, and quit it when you are done.

Agents cannot use passkeys. To sign in with one yourself, open the sign-in page
with the window in front (a tab link, or `agentic-playwright-mcp open work`)
and start the sign-in there.

Sign in to websites only, not to the browser itself: browser sync would copy
your everyday passwords and bookmarks into the agents' browser.

### More than one profile

Run `setup` once per profile. Each gets its own port; point each client (or
each client configuration) at the profile it should use.

### Telling profiles apart in the Dock

Each profile's browser shows its own label on the Dock icon: by default the
first letters of the profile name in a per-profile color. Set your own (up to
3 characters, any CSS color), then restart the profile:

```sh
agentic-playwright-mcp badge work WRK --badge-color "#1a73e8"
agentic-playwright-mcp service install work
```

### Running only while a client app is open

By default a profile runs from login to logout. To run it only while, for
example, the Claude app is open:

```sh
agentic-playwright-mcp activate-with work '/Applications/Claude\.app/Contents/MacOS/Claude'
agentic-playwright-mcp service install work   # apply
```

The browser starts when a matching process appears and stops two minutes after
the last one is gone.

## Tab links

`browser_tab_link` returns `http://127.0.0.1:<port>/focus?target=<tab id>&t=<signature>`
(links are signed with a secret in `profiles/<name>/link-secret`; unsigned
requests to `/focus`, e.g. from a web page, are refused).
Chat apps open http links with your default browser, so by default a click
briefly shows a helper page there, which hands over to the agent window and
closes itself.

To skip your everyday browser entirely on macOS, make a link router such as
[Finicky](https://github.com/johnste/finicky) the default browser: it sends
tab links straight to the bundled link handler and every other link to your
normal browser.

```sh
brew install --cask finicky
agentic-playwright-mcp finicky-config "Brave Browser" > ~/.finicky.js
open -a Finicky        # then make it the default browser in System Settings
```

The rule only matches `/focus` on your profiles' ports, so links to real sites
always open in your normal browser, even if an agent has the same page open.

`browser_tab_link` also declares an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
UI: hosts that render MCP Apps show a card with an Open button that opens the
tab through the host, with no browser or router involved. As of September 2026
the Claude desktop app's Code tab does not yet render MCP Apps from
user-configured servers; once it does, prefer the button over the router.

## Files

Everything a session saves goes to its own folder, never into the project the
agent works in:

```
~/.agentic-playwright-mcp/profiles/<profile>/files/
  0f3c9a1e-5b7d-4e2a-9c61-2d8b4f6a7e10/      one folder per chat, named by its id
    page-….yml  shots/home.png  report.pdf
    a4f2e91c7b3d5e60/                        one per subagent
```

Folders are named by id rather than by chat title, since titles change.

Tool results give every saved file's absolute path (stock Playwright MCP
gives "./shot.png", and agents then search the disk for it). Only the lines
Playwright writes for saved files and downloads are changed; code, evaluate
results and page text keep their file names. A chat that comes back finds its folder
again. Folders nobody has read or written for 7 days are deleted (only folders
the gateway created). Change the location or the retention with `filesDir` and
`filesRetentionDays` in `profiles.json`.

## How it works

```
 chat A ─┐                      ┌──────── one browser per profile ─────────┐
 chat B ─┼─ HTTP MCP ─ gateway ─┤ CDP  [home]  [A: tab tab]  [B: tab]  ... │
 chat C ─┘   (one process)      └───────────────────────────────────────────┘
```

- Every session runs stock Playwright MCP, in a worker thread of its own (so
  one agent's code cannot stall the others: a thread that stops answering is
  restarted, tabs kept), on a Playwright connection of its own. That connection goes through a DevTools proxy in the gateway, which
  shows it a browser holding only the session's tabs. So everything Playwright
  MCP does to "its browser context" (routes, init scripts, tracing, the
  recorder, video, offline mode, events, `page.context()` in
  `browser_run_code_unsafe`) is naturally the session's own, and all of
  Playwright MCP works as upstream.
- All sessions share the browser's default context (cookies, storage,
  logins): it is one real browser profile.
- The gateway itself sees the whole browser through one plain DevTools
  connection: it knows which tab belongs to which session (popups go to the
  owner of the tab that opened them), holds a new tab until its owner's
  Playwright has set it up, opens tabs in the background, and keeps the window
  out of sight.
- Claude Code sends each tool call's tool-use id; the gateway looks it up in
  the chat's transcripts to tell subagents apart.
- A small companion extension, loaded over CDP, manages the tab groups and
  duplicates tabs for forked chats.
- Page scripts added to every tab report permission and passkey requests and
  new-tab links to the gateway.
- Chat titles and forks come from the Claude desktop app's chat files.
- A pinned status tab keeps the window alive and lists the sessions (the
  gateway writes it over DevTools; the gateway's address itself only shows a
  note).

## Things to know

- Each agent works as if it had the browser to itself: its tabs, popups,
  routes, scripts, recordings and traces are its own, and `page.context()` in
  `browser_run_code_unsafe` holds only its tabs. What a real browser profile
  shares stays shared: cookies and site storage (logins), site permissions and
  the browser's own pages (chrome://). Cookie and storage tools act on the
  sites of the agent's own tabs unless it names another domain. This keeps
  agents from reaching each other by accident; it is not a security boundary,
  since the agents' code runs in the gateway process.
  `test/matrix.mjs` checks every tool across two sessions, and
  `test/canary.mjs` searches everything one chat gets for another's secret.
- Remote debugging gives local processes full control of the profile. The ports
  listen on localhost only, agents cannot reach them through their tabs or
  their code, and the gateway answers only local MCP clients (no browser page,
  including one that reaches it under another host name); use a profile
  dedicated to agents, never your everyday browser profile.
- Each chat that uses the browser costs about 60 MB of memory while its thread
  runs; a thread idle for 10 minutes is ended and started again on the chat's
  next call (about half a second), with its tabs, routes, offline mode and
  device emulation. Recordings, traces and videos keep their thread running.
- Downloads go to the chat whose tab started them (from the page, any of its
  frames, or a tab the download opened), into its files folder. A download in
  a tab no chat owns (one you start in the window yourself) goes to
  `profiles/<name>/browser-downloads`, never to your Downloads folder.
- `playwright-core` is pinned to an exact version because the gateway relies on
  internal parts of it; startup fails loudly if they change.
- A page's own `window.open()` (typically a sign-in popup) can still show the
  browser for about a second before the gateway hides it again.
- Closing the browser window (red button) closes every agent's tabs in it; the
  gateway puts a new hidden window back. Use the yellow button or Cmd+H instead.
- The browser's icon stays in the Dock while it runs (it is a normal Chrome).
- Permission decisions are per site and shared by every session. The browser
  forgets decisions made over DevTools when the connection closes, so the
  gateway keeps them (in `sessions.json`) and sets them again. Requests the
  page script cannot see (local network access, for example) are refused
  silently; agents can allow them ahead of time with `browser_permission`.
- A fork's copies are made when the fork first uses the browser, from the
  original chat's tabs at that moment, and only for forks made in the Claude
  desktop app (it records the original chat; CLI `--fork-session` is not
  detected). A copy reloads its page: state the page kept only in memory is
  lost, and pages that act when loaded (payment steps, one-time links, form
  results) may do it again or show an error. Cookies are shared, so the copy
  is signed in wherever the original was.
- "Nobody can see the browser" means headless, hidden, or its window
  minimized. A passkey request in a tab behind other tabs of a shown window
  still goes through to the browser's prompt.

## Commands

```
setup <profile> [--browser chrome|brave|chromium|edge|<path>] [--headless]
profile add <name> [--browser …] [--port N] [--cdp-port N] [--headless] [--config <file>] [--badge X] [--badge-color C]
badge <profile> <label> [--badge-color <css color>]
profile list | profile remove <name>
start <profile> [--config <file>] browser and gateway in the foreground
service install|uninstall <profile>
activate-with <profile> <regex> [--exclude <regex>] | --always
open <profile>                   show the browser window
login <profile>                  plain browser (no remote control) for signing in
config <profile>                 print the MCP client entry
link-handler install [--force]   (macOS) tab links and window activation
finicky-config [browser]         print a Finicky config for tab links
identity                         headersHelper output
```

Data lives in `~/.agentic-playwright-mcp` (override with
`AGENTIC_PLAYWRIGHT_HOME`): `profiles.json`, and per profile the browser data,
`gateway.log` and `sessions.json` (which chat owns which tab, so a restarted
gateway can hand the tabs back).

Playwright MCP's own options come from a Playwright MCP config file (the
profile's `config`, or `--config`) and from `PLAYWRIGHT_MCP_*` variables, as
upstream: timeouts, secrets, snapshot and output settings, `capabilities`,
`browser.initScript`, `network.allowedOrigins` / `blockedOrigins`,
`testIdAttribute`. They apply to every session of the profile. Options for
launching the browser or creating its context (headless, viewport, user agent,
proxy, storage state, isolated, ...) do not apply: the gateway connects to the
profile's running browser.

### Screenshot diagnostics

The profile's `gateway.log` records when a `Page.captureScreenshot` command is
sent to Chrome and when its reply arrives. A pending command is logged after
5 seconds and again after 35 seconds without a reply. Each line includes only
an opaque session suffix, short tab ID, elapsed time and cached window
visibility; it does not contain a URL, image data or CDP error text. A `sent`
line followed by `no reply` points to Chrome or the CDP connection. A `reply`
line followed by a tool timeout points downstream of Chrome's response. Late
replies are still logged; pending records are discarded after five minutes.

The browser tool's `timeout` argument controls how long the gateway waits for
the entire call. Playwright's action timeout is separate and comes from its
`timeouts.action` configuration (5 seconds by default).

Stopping the service (`launchctl kickstart -k`, reinstalling it) leaves the
browser running, so agents keep their tabs across a gateway restart;
`service uninstall` closes it. `start` in the foreground closes the browser on
Ctrl+C.

## Development

```sh
npm install
npm run build
```

`test/` holds self-contained pass/fail tests (each starts its own headless
browser and gateway; `headed` needs a screen and shows a window) and scripts
used during development against a running gateway; see
[test/README.md](test/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
