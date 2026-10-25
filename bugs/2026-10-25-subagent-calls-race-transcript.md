---
status: fixed
area: subagents
found: 2026-10-25
filed: 2026-10-25
reproducible: yes
fixed-in: 9e43c5f (root; 9d17f01 was a mitigation) — test/subagent-transcripts.mjs late, parallel, idle and unnamed-call cases
---

# Subagent calls go to the parent chat when Claude Code writes the tool_use to its transcript after the call arrives

## Symptoms

One desktop chat ran up to five background research subagents at once, most of them using the browser.

- A subagent's `browser_navigate` result listed a tab (`<parent page title>`) that only the parent
  chat had opened, and said the call had waited for a `browser_tabs` call the subagent never made.
- Right after that, the parent's own tab (`<tab-id>`, the parent's page) showed the subagent's page
  (`<subagent's site>`) in the parent's `browser_tabs` list.
- Another subagent got `Tab "<tab-id>" not found` from `browser_navigate` while `browser_tabs` listed that tab as
  current; its parallel `browser_navigate` / `browser_evaluate` "ran on a different tab state", `browser_evaluate`
  returned the previous page, and snapshots were saved outside its subagent folder.
- A third subagent's `browser_tabs close` failed in the parent's session (see Evidence).

All are one thing: some calls of a subagent ran in the parent chat's session (its tabs, current tab, call queue and
files folder), others in the subagent's own.

## Environment

Claude Code 2.1.267 in the desktop app (Code tab), one chat, 3–5 background subagents at a time (general-purpose
agents doing web research, some with the browser), 2026-10-25 16:40–18:45 UTC. Gateway running since earlier the
same day; no restarts.

## Steps to reproduce

`node test/subagent-transcripts.mjs`, case "subagent call written to the transcript N ms late": the fake client
appends the subagent's `tool_use` line 900 ms / 2500 ms after it sends the call (as Claude Code does).

- Expected: the subagent gets its own tab; the chat keeps its `who=main` tab.
- Actual (before the fix): the chat's only tab becomes `who=l1`, then `who=l2` — the subagent's navigations ran in
  the chat's session.

## Evidence

- `profiles/<profile>/gateway.log`, 16:47:41.365Z: `subagent lookup: tool_use toolu_01Qd… of <chat> not found (not
  in its transcripts); the call goes to the chat`. The transcript has that `tool_use` with `timestamp`
  16:47:41.091Z, i.e. the lookup gave up before the line reached the disk. Only the first miss per session is
  logged (`_missLogged`), so every later miss of the day — the subagents' — left no trace.
- 18:03:46Z: `browser_tabs from <chat> failed: … connectOverCDP: Timeout 15000ms exceeded` — a subagent's call
  (a subagent whose thread had just been ended at 18:02:58Z) logged under the parent's title.
- Measured on the live chat (a watcher polling the transcript every 5 ms): `tool_use` lines reach the disk
  117–949 ms after their `timestamp`; the first call of a parallel batch was the slowest (949 ms).

## Cause

`TranscriptIndex.lookup` (`src/subagents.ts`) scans the transcripts five times, 50 ms apart, then gives up, and
`Gateway._autoTarget` sends an unknown call to the chat. Both rest on the assumption written in the file header:
"Claude Code appends that block to the caller's transcript before running the tool". Current Claude Code does not:
the line is written asynchronously, often after the MCP request has arrived. The tests encoded the same
assumption (they append before calling), so they never saw it.

## Suggested fix

(As filed; the root fix below replaced it.) Wait for the line instead of guessing: while the chat has subagents that are alive (a subagent transcript written
recently), keep rescanning until the call's `tool_use` appears (a few seconds' cap); a found id resolves at once, so
calls from the chat are delayed only by the write itself. With no live subagents nothing but the chat can be
calling, so keep the short wait. Log every miss that still happens. Test: the late-transcript case above.

## First fix (replaced by the root fix below)

9d17f01: `TranscriptIndex.lookup` rescans every 25 ms until the call's `tool_use` line appears, up to 5 s while any
subagent of the chat wrote its transcript in the last 10 minutes (`subagentsAlive()`), 250 ms otherwise. A found id
answers at once, so the chat's own calls wait only for Claude Code's write. `_autoTarget` logs every miss that
happens while subagents are alive. Without the fix the new cases fail exactly like the live chat: every subagent's
navigation lands in the chat's one tab.

## Root fix

9d17f01 only widened the guess. Its "subagent wrote its transcript in the last 10 minutes" rule still sent a subagent
that had been quiet (a long shell command) to the parent after 250 ms, and any line later than 5 s still landed in the
parent. The real defect was the fallback itself: an unidentified call ran in the chat's session. 9e43c5f: every call of a
chat is written to one of its transcripts, so the lookup waits for the line (30 s cap) and a call that is never named is
refused ("repeat the call"); only a chat whose transcripts cannot be found at all keeps routing to itself. Cost: each
browser call in Claude Code waits for its own line (0.1–1 s measured).
