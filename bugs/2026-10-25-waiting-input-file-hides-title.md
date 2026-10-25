---
status: fixed
area: sessions
found: 2026-10-25
filed: 2026-10-25
reproducible: yes
fixed-in: 8d796e8 (test/titles.mjs)
---

# A chat's waiting-input file is read as the chat itself: the tab group loses its title and the CLI session id

## Symptoms

While a desktop chat waited for the user, its tab group (and its subagents' groups) were renamed to the project folder's
name and back once the chat went on:

```
17:12:41Z session renamed: <chat title> -> <folder name>
17:14:37Z session renamed: <folder name> -> <chat title>
18:51:43Z session renamed: <chat title> -> <folder name>
18:51:43Z session renamed: <chat title> · <subagent> -> <folder name> · <subagent>
18:51:58Z session renamed: <folder name> -> <chat title>
```

## Environment

Claude desktop app (Code tab), 2026-10-25.

## Steps to reproduce

`node test/titles.mjs`: a chat file `<account>/<org>/<id>.json` with a title and a CLI session id, and a newer
`<account>/<org>/waiting-input/<id>.json` containing `{}`.

- Expected: `DesktopChatFile.read()` returns the chat's title and CLI session id.
- Actual (before the fix): `{}` — no title, no CLI session id.

## Evidence

The app keeps `claude-code-sessions/<account>/<org>/waiting-input/<chat id>.json` (content `{}`) next to the chat's own
file, written when the chat starts waiting for input; at the renames above it was the newest file of that name.

## Cause

`findDesktopChatFiles` (`src/titles.ts`) collected every file named `<id>.json` up to three folders deep, so the
waiting-input marker counted as one more copy of the chat, and `DesktopChatFile.read()` takes the newest copy. The title
fell back to the folder name, and `_transcriptLocation` lost the chat file's CLI session id (falling back to the
connect-time header, which is wrong after the app continued the chat under a new id).

## Suggested fix

Accept only `<account>/<org>/<id>.json`. Test: `test/titles.mjs`.

## Fix

8d796e8: `findDesktopChatFiles` takes only files exactly two folders below `claude-code-sessions` (`<account>/<org>/<id>.json`).
