---
name: agentic-browser
description: How to use the shared agent browser (the `browser` MCP server, tools named browser_*, from agentic-playwright-mcp). Read before the first browser call in a chat, and before spawning subagents that will use the browser. Covers tab groups, subagents, logins, tab links, what is shared between chats, and the rule to report every browser problem to the user.
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
  unless you give them a link (below). Never assume they are watching.
- Only use the browser when the task needs it. When the user checks a UI
  themselves, do not open pages or take screenshots to "verify" unless asked.

## Tabs do not live forever

Your tabs and group are closed when this chat's process ends (app quit, chat
archived) or after 24 hours without any browser call. When you resume an older
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

## Logins, captchas, anything for the user

- Never type passwords, codes or payment details. When a page needs the user
  (login, 2FA, captcha, consent, review), tell them what is needed, call
  `browser_tab_link` and give them its link as a markdown link, e.g.
  `[Open the login page](http://127.0.0.1:8931/focus?target=…)`. Clicking it
  brings the browser window to the front on that tab. Then wait for them to
  confirm before continuing.
- Give such a link whenever the user might want to look at a page (a result,
  something to double-check). It opens nothing by itself; the user decides.
- `browser_show_tab` opens the window immediately, without asking. Use it only
  when the user explicitly asks to see a page right now ("покажи").
- If a site refuses to sign in inside the automated browser (for example Google
  saying the browser may not be secure), tell the user to run
  `agentic-playwright-mcp login <profile>`, sign in there, and quit that window.

## No login? Stop and say so

The browser is not logged in everywhere yet; the user adds logins as they are
needed. When a task needs a site or service where the browser is not signed in
(a login page, "sign in to continue", a paywall for members, an empty account
view), especially the user's own accounts (Google, study portals, messengers,
LinkedIn, banking, work tools):

1. Stop the task at that point.
2. Tell the user which service needs a login and what for, and give a
   `browser_tab_link` link to its login page so they can sign in right there.
3. Wait for them to confirm, then continue.

Do not work around a missing login: no other accounts, no guessing, no public
or cached copies, no other browser tools, and no carrying on with partial data
as if nothing happened. Logins are shared by all chats of this setup, so one
sign-in fixes it for every agent.

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

Snapshots, screenshots, videos and downloads are saved under your working
directory (`.playwright-mcp/`). Give the user the path when a file matters.

## Report every problem (hard requirement)

This browser is new infrastructure and gets fixed only through honest reports.
Whenever something goes wrong, say so in your reply to the user, in its own
clearly marked paragraph, even if you worked around it:

- a tool error, timeout or crash (quote the exact error text);
- the wrong tab, a missing tab or group, tabs that belong to someone else;
- the browser window or focus jumping in front of the user;
- a missing login (see "No login? Stop and say so");
- a site that refuses the automated browser;
- anything that behaves differently from this skill.

State what you called, what you expected, what happened and what you tried.
Do not retry the same failing call more than twice, and do not silently switch
to other browser tools (for example `claude-in-chrome`) to get around a
problem; ask the user first.
