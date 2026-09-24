# agentic-playwright-mcp

Many AI agents, one real browser, one tab group each.

An MCP server that lets any number of agent sessions (Claude Code chats,
their subagents, Codex, other MCP clients) work in parallel in **one normal,
logged-in browser**. Every session gets its own Chrome tab group and only sees
its own tabs, while all of them share the browser's cookies and logins. The
browser runs minimized in the background and does not steal focus.

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
  popups those tabs open.
- **Tab groups**: each session's tabs sit in a named, colored tab group (the
  chat title when the client reports it).
- **Subagents, automatically**: Claude Code subagents are recognized and get
  their own tab group, running in parallel. Other clients call
  `browser_subagent_start`.
- **Quiet**: the browser starts without a window and stays minimized; tabs open
  in the background; links that open new tabs become background tabs.
- **Tab links**: `browser_tab_link` gives the agent a link to put in the chat;
  clicking it opens the window on that tab (for logins, captchas, review).
- **Cleanup**: a session's tabs close when its client process exits or after a
  day without browser use.
- **Per-tab device emulation**: `browser_emulate_device` emulates a phone in
  one tab without affecting other agents.

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
get the chat's title, a resumed chat gets its tabs back, and tabs close as soon
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

Sign in to websites only, not to the browser itself: browser sync would copy
your everyday passwords and bookmarks into the agents' browser.

### More than one profile

Run `setup` once per profile. Each gets its own port; point each client (or
each client configuration) at the profile it should use.

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

`browser_tab_link` returns `http://127.0.0.1:<port>/focus?target=<tab id>`.
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

## How it works

```
 chat A ─┐                      ┌──────── one browser per profile ─────────┐
 chat B ─┼─ HTTP MCP ─ gateway ─┤ CDP  [home]  [A: tab tab]  [B: tab]  ... │
 chat C ─┘   (one process)      └───────────────────────────────────────────┘
```

- The gateway connects to the profile's browser over the Chrome DevTools
  Protocol and creates one Playwright MCP backend per session, all sharing the
  browser's default context (cookies, storage, logins).
- Per session it changes three things in the stock backend: which pages it
  adopts (only its own), how it opens tabs (in the background) and how it
  switches tabs (without bringing the window to the front).
- Claude Code sends each tool call's tool-use id; the gateway looks it up in
  the chat's transcripts to tell subagents apart.
- A small companion extension, loaded over CDP, manages the tab groups.
- A pinned status page at the gateway's address keeps the window alive and
  lists the sessions.

## Things to know

- Sessions share one browser context, so anything context-wide is shared:
  cookies, `browser_route`, offline mode, storage state.
- Remote debugging gives local processes full control of the profile. The ports
  listen on localhost only; use a profile dedicated to agents, never your
  everyday browser profile.
- `playwright-core` is pinned to an exact version because the gateway relies on
  internal parts of it; startup fails loudly if they change.
- A page's own `window.open()` (typically a sign-in popup) can still raise the
  window for about a second before the gateway hands focus back.
- `browser_pdf_save` only works in headless profiles.

## Commands

```
setup <profile> [--browser chrome|brave|chromium|edge|<path>] [--headless]
profile add <name> [--browser …] [--port N] [--cdp-port N] [--headless]
profile list | profile remove <name>
start <profile>                  browser and gateway in the foreground
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
`AGENTIC_PLAYWRIGHT_HOME`): `profiles.json`, and per profile the browser data
and `gateway.log`.

## Development

```sh
npm install
npm run build
```

`test/` holds scripts used during development against a running gateway; see
[test/README.md](test/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
