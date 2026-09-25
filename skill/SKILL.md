---
name: agentic-browser
description: How to use the shared agent browser (the `browser` MCP server, tools named browser_*, from agentic-playwright-mcp). Read before the first browser call in a chat, and before spawning subagents that will use the browser. Covers tab groups, subagents, logins and credentials, tab links, what is shared between chats, and the rule to report every browser problem to the user.
---

# Shared agent browser

The `browser` MCP server is a real, normal Chrome that runs minimized in the
background and is shared by every agent of this setup. Logins live in it
permanently. It is Playwright MCP underneath, so the usual `browser_*` tools
work, with a few differences described here.

## Your tabs

- Your chat gets its own tab group, titled after the chat. You only see and
  control tabs you opened (plus pages your tabs open). Other chats cannot see
  yours and you cannot see theirs.
- Just call `browser_navigate`; the first call opens your first tab. More tabs:
  `browser_tabs` with action `new`. `browser_tabs` lists your tabs with short
  ids; pass `"tab": "<id>"` to any tool to act on a specific tab.
- Links that open a new tab open it in the background inside your group; they
  do not switch your current tab. Check `browser_tabs` after clicking one.
- Close tabs you no longer need with `browser_tabs` action `close`. Do not use
  `browser_close`.
- Everything happens in the background: the user does not see the window
  unless you give them a link (see "Showing pages to the user"). Never assume
  they are watching.
- A chat forked in the Claude desktop app starts with copies of the original
  chat's tabs (listed under "Tabs of the original chat" in your first result);
  the originals stay with that chat. The copies are reloaded pages: take a
  snapshot before acting, and on payment, one-time or form-result pages check
  that the copy did not repeat or break something.
- Only use the browser when the task needs it. When the user checks a UI
  themselves, do not open pages or take screenshots to "verify" unless asked.

## Calls run one at a time

Your browser calls run one after another, never in parallel: a call waits
until your previous one has finished, and its result says so when it waited.
So never start a call that may not end on its own, such as an evaluate that
awaits a promise the page may never resolve or a long polling loop; poll in
short calls instead. Every call is given up after 120 seconds (plus the wait of
`browser_wait_for`) and a cancelled call is dropped at once, so a stuck call
no longer blocks the next ones, but it may still be running in the page. Pass
`"timeout"` (seconds) only for a call that really needs longer.

## Tabs do not live forever

Your tabs and group are closed when this chat's process ends (app quit, chat
archived) or after 24 hours without any browser call. A gateway restart or the
user's laptop sleeping does not close them. When you resume an older
chat, first check `browser_tabs`: if your tabs are gone, reopen what you need
from the URLs in the conversation instead of assuming the old state.

## Subagents

In Claude Code nothing is needed: the gateway recognizes which subagent is
calling and gives each one its own tab group ("Chat title · subagent
description"), running in parallel with the others and with the main chat.
A subagent sees only its own tabs, not the main chat's; to hand a page over,
pass its URL.

In other clients (Codex and others) a subagent first calls
`browser_subagent_start` with a short label and then passes the returned id as
`"agent": "<id>"` in every browser call. Put that into the prompt of any
subagent you spawn there.

## Logins

The browser is not logged in everywhere yet; logins get added as tasks need
them. When a task needs a site or service where the browser is not signed in
(a login page, "sign in to continue", a members-only page, an empty account
view):

1. **Look for credentials in the project first**: files the project keeps for
   this (`.env`, credential or secrets files, notes in the project's docs or
   memory) and environment variables. If you find ones for this service, sign
   in with them.
2. **Otherwise stop and give the user the choice**, in one message: which
   service needs a login and what for, and either
   - they sign in themselves: give a `browser_tab_link` link to the login page,
     or
   - they send the credentials in the chat and you sign in.

   Then wait for their answer.
3. Codes the user receives (2FA, SMS, email codes) always come from the user:
   ask for the code, or let them enter it via the tab link.
4. **Passkeys do not work for agents.** When a site asks for one, the request
   is cancelled at once and your tool result says so under "Passkey
   requests". Pick another way the page offers (Google: "Try another way",
   then "Enter your password") and go on with steps 1–3. If the user wants to use
   their passkey, give them a tab link to the sign-in page so they start it
   there with the window in front.

Using credentials:

- Use them only to sign in to the service they belong to. Do not repeat them in
  your replies, and do not write them into files, commit messages or logs
  unless the user asks you to save them.
- Never enter payment details (card numbers, bank transfers, purchases) unless
  the user explicitly asks for that specific action.
- If sign-in fails (wrong password, account locked, a captcha, "this browser may
  not be secure"), stop after one attempt and tell the user; do not retry with
  guesses. For Google's "browser may not be secure", the user can run
  `agentic-playwright-mcp login <profile>`, sign in there and quit that window.

Do not work around a missing login: no other accounts, no public or cached
copies, no other browser tools, and no carrying on with partial data as if
nothing happened. Logins are shared by all chats of this setup, so one sign-in
fixes it for every agent.

## Permission requests (camera, microphone, location, notifications, ...)

The browser shows no permission prompts. Requests appear under "Permission
requests" in your tool results; answer with `browser_permission` ("allow" or
"deny"). It returns only a confirmation: call `browser_snapshot` to see the page.

- Camera, microphone, location, notifications, MIDI: the page waits up to two
  minutes for your answer.
- Others (clipboard, fonts, ...) need a fresh click, so they are refused at
  once: allow, then repeat the click.
- Allow only what the task needs; deny notifications unless the task is about
  them. Decisions apply to the whole site, for every chat of this setup.

## Showing pages to the user

- When the user should look at or act in a page (a captcha, a consent screen, a
  result to review, something to double-check), call `browser_tab_link` and
  give them its link as a markdown link, e.g.
  `[Open the results](http://127.0.0.1:8931/focus?target=…)`. Clicking it
  brings the browser window to the front on that tab; nothing opens until they
  click.
- `browser_show_tab` opens the window immediately, without asking. Use it only
  when the user explicitly asks to see a page right now ("покажи").

## Shared between all chats of this setup

Cookies, local storage and logins are shared, and so is anything that acts on
the whole browser context. Unless the user asks for it, do not clear cookies or
storage, do not load a storage state, and do not use `browser_route` or network
offline mode: they affect every other agent too.

## Phones and screen sizes

Use `browser_emulate_device` (for example `"device": "iPhone 15"`); it only
affects your current tab. Reset it with `"reset": true` when done. Do not use
`browser_resize` to fake a phone.

## Files

Everything the browser saves (screenshots, snapshots, downloads, videos,
traces, and any file you name with a relative path) goes into this chat's own
files folder, never into the project. Results give each file's absolute
path: use it as is, never search the disk for a file (`find /` makes macOS
ask the user for access). Subagents get a subfolder.

- The folder is temporary: it is deleted after a week without use. Copy
  anything worth keeping into the project yourself (and tell the user where).
- To upload a project file, pass its absolute path.
- Give the user the full path when a file matters to them.

## Report every problem (hard requirement)

This browser is new infrastructure and gets fixed only through honest reports.
Whenever something goes wrong, say so in your reply to the user, in its own
clearly marked paragraph, even if you worked around it:

- a tool error, timeout or crash (quote the exact error text);
- the wrong tab, a missing tab or group, tabs that belong to someone else;
- the browser window or focus jumping in front of the user;
- a missing login (see "Logins");
- a site that refuses the automated browser;
- anything that behaves differently from this skill.

State what you called, what you expected, what happened and what you tried.
Do not retry the same failing call more than twice, and do not silently switch
to other browser tools (for example `claude-in-chrome`) to get around a
problem; ask the user first.
