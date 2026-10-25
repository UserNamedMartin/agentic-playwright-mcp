# Bugs

Bugs found while using the gateway, one Markdown file each. Agents working on this repo read the
open ones before they start; an agent that hits a problem while using the browser files one here.

## Index

| File | Status | Area | Found | Summary |
|---|---|---|---|---|
| [2026-10-25-waiting-input-file-hides-title.md](2026-10-25-waiting-input-file-hides-title.md) | open | sessions | 2026-10-25 | The desktop app's waiting-input/<id>.json marker is read as the chat itself: tab groups lose their title and the chat's CLI session id while it waits |
| [2026-10-25-stuck-tab-blocks-reconnect.md](2026-10-25-stuck-tab-blocks-reconnect.md) | open | sessions | 2026-10-25 | A tab stuck in a script keeps a new session thread from connecting: every call, even closing that tab, fails with connectOverCDP's 15 s timeout |
| [2026-10-25-given-up-run-code-keeps-running.md](2026-10-25-given-up-run-code-keeps-running.md) | fixed | sessions | 2026-10-25 | browser_run_code_unsafe keeps running in the session's thread after the gateway gave it up or the agent cancelled it |
| [2026-10-25-subagent-calls-race-transcript.md](2026-10-25-subagent-calls-race-transcript.md) | fixed | subagents | 2026-10-25 | Claude Code writes a tool_use to its transcript after the call arrives; the lookup gives up after 250 ms and the subagent's call runs in the parent chat's session |
| [2026-10-20-update-asks-keychain-password.md](2026-10-20-update-asks-keychain-password.md) | fixed | gated-browser | 2026-10-19 | Gated browser updates run codesign against a locked keychain, so the user gets a password dialog every hour after a reboot |
| [2026-10-12-gate-strands-home-window.md](2026-10-12-gate-strands-home-window.md) | fixed | front | 2026-10-12 | The show gate keeps the home window from ever being ordered in, so tab links show the app for 3 s and the guard hides it again |
| [2026-10-09-pages-show-the-browser.md](2026-10-09-pages-show-the-browser.md) | fixed | front | 2026-10-08 | A page's own `window.open` shows the hidden browser; the focus guard only hides it afterwards, so every call is a flash |
| [2026-10-01-subagents-attributed-to-parent.md](2026-10-01-subagents-attributed-to-parent.md) | fixed | subagents | 2026-09-30 | After a chat's Claude Code session id changes mid-chat, every subagent call is attributed to the parent: shared tab group and one call queue |

Keep the table sorted newest first; update the row when the status changes.

## Filing a bug

1. **Check first:** search this folder (and `git log`) for the symptom; add to an existing file rather than opening a second one.
2. **One file per bug:** `YYYY-MM-DD-short-slug.md` (the date it was filed, a slug of 3–6 words naming the defect, not the symptom's place).
3. **Add a row to the index** above in the same commit.
4. **No personal data** (this repo's rule): no user names, home paths, profile names, ports of a particular machine, chat titles or client names. Write paths relative to known roots (`<configDir>/projects/<project>/…`, `profiles/<profile>/gateway.log`) and replace ids with placeholders (`<old-session-id>`) unless the id itself is the point, then shorten it (`3fae…`).
5. Commit it on its own (`Bugs: <slug>`), separate from any fix.

## What a bug report contains

Front matter, then these sections in this order. Leave a section out only when it truly does not apply.

```markdown
---
status: open            # open | fixed | wontfix | cannot-reproduce
area: subagents         # sessions | subagents | proxy | tools | files | front | extension | skill | …
found: 2026-09-30       # when it happened
filed: 2026-10-01
reproducible: no        # yes (with the steps below) | sometimes | no (evidence only)
fixed-in:               # the commit that fixes it, with its test
---

# One sentence naming the defect

## Symptoms
What the agent or the user saw, as observed: tool results quoted exactly, tab ids, messages.

## Environment
Client (Claude Code CLI / desktop, Codex, …), how the browser was used (main chat, background
subagents, how many at once), gateway start time, anything unusual (restarts, resumed chats).

## Steps to reproduce
Numbered, minimal, with the expected and the actual result of each step. If it does not reproduce,
say so and list what was tried.

## Evidence
Log lines from `gateway.log` with timestamps, file locations, counts – what proves the claim.

## Cause
Confirmed (with file:line) or a hypothesis, marked as such.

## Suggested fix
Optional. Plus the test that should fail without the fix (this repo's rule: every fix has a test).

## Workaround
What agents can do meanwhile.
```

When fixing: set `status: fixed` and `fixed-in: <commit>`, add a short "## Fix" section (what changed,
which test covers it), update the index row. A bug that turns out not to be one gets `wontfix` with
the reason; one nobody can trigger again after a real attempt gets `cannot-reproduce` with what was tried.
