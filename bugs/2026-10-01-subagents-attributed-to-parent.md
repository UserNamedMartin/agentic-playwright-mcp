---
status: fixed
area: subagents
found: 2026-09-30
filed: 2026-10-01
reproducible: no (evidence only; the cause is visible in the code)
fixed-in:
---

# After a chat's Claude Code session id changes mid-chat, every subagent call is attributed to the parent

## Symptoms
For one desktop chat, over an evening of work (≈ 17:35–21:00 UTC, 2026-09-30), background subagents
(Agent tool, `run_in_background`, up to three at once, each driving the browser for 10–45 minutes):
- saw tabs they never opened in `browser_tabs list`: the parent chat's tab and other subagents' tabs;
- acted on each other's tabs: a tab one subagent had been given as "its first tab" was the parent's,
  and another subagent's navigation moved it to a different page;
- got "This call waited N s for your previous call" (4–34 s) on most calls while that agent had
  nothing running: all agents were queued behind each other.

In short: no subagent got its own session; the parent's session served all of them.

## Environment
- Claude Code desktop app, one local chat (`local_<chat-id>`), the gateway started the day before
  (2026-09-29T13:25Z) and running without a restart.
- The chat's Claude Code session id changed in the middle of the chat (the desktop app continued the
  same chat under a new CLI session id): the transcript `<old-session-id>.jsonl` stops at 17:04Z and
  everything after it, including every subagent transcript, is written under `<new-session-id>`.
  The desktop chat file `claude-code-sessions/…/local_<chat-id>.json` now holds
  `cliSessionId: <new-session-id>`.

## Steps to reproduce
Not reproduced on demand. What was tried on 2026-10-01 (after the gateway restarted and the Claude
process restarted, so the process environment carried the new id) – every probe behaved correctly
(own `…#<agentId>` session, own group with one `about:blank`, own files subfolder, no foreign tabs,
no "waited" messages):
1. two fresh background subagents started at once, each with an 8 s `waitForTimeout` overlapping the other's calls;
2. a subagent resumed with SendMessage, same steps;
3. a subagent whose first browser call came 150 s after it started;
4. the parent making overlapping calls during 2.

To trigger it deliberately: start a Claude Code chat, make one browser call (the gateway creates the
session and its transcript index), make the chat continue under a new CLI session id (the desktop
app does this on its own in some continuations; in a test, write the main transcript and the
`subagents/` folder under a second session id while the request headers keep the first), then call
the browser from a subagent. Expected: a `…#<agentId>` session. Actual (by the code below): the call
lands in the parent's session.

## Evidence
- `gateway.log` for that run: one `session started: <chat> (local_<chat-id>, pid <pid>)` at
  2026-09-30T17:35:05Z and no `session started: <chat> · <subagent> (…#<agentId>)` line until the
  gateway restarted at 2026-10-01T06:34:53Z. All 410 screenshot calls of the evening were logged
  under one `session=<id>`; the first came from a subagent, ten minutes before the parent's first call.
- The subagents' screenshots of that evening were saved straight into the chat's files folder
  (`files/<chat-id>/…png`), not into `files/<chat-id>/<agentId>/`.
- Between the gateway start on 2026-09-29T13:25Z and the restart, the log has no subagent session for
  any chat; the last one before is 2026-09-28T20:46Z (a different chat, `…#<agentId>`).
- After the restart, the same chat's subagents get `local_<chat-id>#<agentId>` sessions at once.

## Cause
Confirmed in the code, not yet by a test:
- `src/identity.ts:28` – `claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? agent.env['CLAUDE_CODE_SESSION_ID'] ?? desktop?.cliSessionId`.
  The environment variable is fixed when the client process (and its MCP helper) starts, so after the
  chat moves to a new CLI session id the header keeps sending the old one. The desktop chat file,
  which has the current id, is only the last fallback.
- `src/gateway.ts:821–829` – `_transcriptIndex()` builds one `TranscriptIndex` per root session (keyed by
  `root.info.id`) with the `claudeSessionId` it had then and never rebuilds it, even when a later
  request carries a different id (`_sessionFor`, `gateway.ts:929`, updates `info.claudeSessionId` but
  not the cached index).
- `src/subagents.ts` – the index scans only `<old-session-id>.jsonl` and `<old-session-id>/subagents/`;
  the new subagents' `tool_use` ids are never found, `lookup()` returns `undefined` after five tries,
  and `_autoTarget()` (`gateway.ts:1037`) silently falls back to the parent session.

## Suggested fix
- Prefer the desktop chat file's current `cliSessionId` over the environment variable when both
  exist, and re-read it on a lookup miss (`DesktopChatFile.read()` already tracks the file's mtime).
- Rebuild the cached `TranscriptIndex` when the root session's `claudeSessionId` changes.
- On a lookup miss, scan the project folder's other recently written session transcripts (and their
  `subagents/`) for the `tool_use` id before falling back.
- Log the fallback: "tool_use <id> not found in <n> transcripts; attributing to the parent" – it was
  silent, which is why it went unnoticed for a day.
- Test: a fake config dir where the main transcript moves from session id A to B mid-run while the
  headers keep A; a subagent call (its `tool_use` id only in `B/subagents/agent-<id>.jsonl`) must land
  in `…#<agentId>`. `matrix.mjs` or a new `subagents.mjs`.

## Workaround
- Subagents open their own tab with `browser_tabs` action `new` and pass its `tab` id to every call;
  they still share the parent's queue.
- Restarting the client process (so its environment carries the new session id) and the gateway
  restores attribution; check `gateway.log` for `session started: … · <subagent>` lines.

## Fix
Found again on 2026-10-08 in a fresh desktop chat (no id change at all): the chat's first browser call
created its session without `claudeSessionId` and without `configDir`. The headers helper runs when
the client connects, before the desktop app has written `cliSessionId` into the chat file, and the
Claude Code process itself carries no `CLAUDE_CODE_SESSION_ID`; the helper sent the config dir only
together with a session id. So the gateway had no transcripts to read and every subagent call of
that chat fell back to the chat, silently. The session-id change above is the same defect: the
transcript location was fixed at connect time.

- `gateway.ts` `_transcriptLocation()`: the transcript session id is read from the desktop chat file
  on each lookup (mtime-cached) and wins over the header; the config dir comes from the header or,
  for clients connected without it, the agent process's environment (`CLAUDE_CONFIG_DIR`, else
  `~/.claude`). The cached `TranscriptIndex` is rebuilt when the location changes (logged).
- `identity.ts`: the helper always sends `x-agent-config-dir` for Claude Code, with or without a
  session id.
- A lookup that finds nothing is logged once per chat.
- Test: `test/subagent-transcripts.mjs` (self-contained): late session id, changed session id, stale
  header, config dir from the environment. Without the fix the chat's own tab list shows the
  subagent's tab.
