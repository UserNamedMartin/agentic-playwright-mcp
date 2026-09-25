// Chat titles for tab groups. A chat is often still untitled when it connects
// and can be renamed at any time, so the gateway looks the title up again
// while the chat uses the browser:
// - Claude desktop app: one JSON file per chat, named after the host session
//   id, with the current title;
// - Claude Code CLI: `/rename` appends a custom-title entry to the transcript
//   (read by TranscriptIndex, see subagents.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// forkedFrom: the chat this one was forked from (the desktop app's fork command).
export type DesktopChat = { title?: string; cliSessionId?: string; forkedFrom?: string };

// Claude desktop keeps its chats under <app support>/Claude*/claude-code-sessions/<account>/<org>/<id>.json.
// Several copies of the same chat can exist (one per app data folder); the most
// recently written one wins.
export class DesktopChatFile {
  private _hostSessionId: string;
  private _files: string[] | undefined;
  private _mtime = 0;
  private _chat: DesktopChat | undefined;

  constructor(hostSessionId: string) {
    this._hostSessionId = hostSessionId;
  }

  read(): DesktopChat | undefined {
    this._files ??= findDesktopChatFiles(this._hostSessionId);
    let newest: string | undefined;
    let newestMtime = 0;
    for (const file of this._files) {
      const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (mtime > newestMtime) {
        newest = file;
        newestMtime = mtime;
      }
    }
    if (!newest) {
      // Not written yet, or moved: search again next time.
      this._files = undefined;
      return this._chat;
    }
    if (newestMtime === this._mtime)
      return this._chat;
    try {
      const chat = JSON.parse(fs.readFileSync(newest, 'utf8'));
      this._chat = {
        title: typeof chat.title === 'string' && chat.title.trim() ? chat.title.trim() : undefined,
        cliSessionId: typeof chat.cliSessionId === 'string' ? chat.cliSessionId : undefined,
        forkedFrom: typeof chat.forkedFromSessionId === 'string' && chat.forkedFromSessionId !== this._hostSessionId ? chat.forkedFromSessionId : undefined,
      };
      this._mtime = newestMtime;
    } catch {}
    return this._chat;
  }
}

export function desktopChat(hostSessionId: string | undefined): DesktopChat | undefined {
  return hostSessionId ? new DesktopChatFile(hostSessionId).read() : undefined;
}

function findDesktopChatFiles(hostSessionId: string): string[] {
  // AGENTIC_CLAUDE_APP_SUPPORT points tests at fake chat files (changing HOME
  // instead would also move the browser's keychain on macOS).
  const supportDir = process.env.AGENTIC_CLAUDE_APP_SUPPORT ??
      (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  let appDirs: string[] = [];
  try {
    appDirs = fs.readdirSync(supportDir).filter(name => /^Claude/.test(name));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const appDir of appDirs)
    findFiles(path.join(supportDir, appDir, 'claude-code-sessions'), `${hostSessionId}.json`, 3, found);
  return found;
}

function findFiles(dir: string, name: string, depth: number, found: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name)
      found.push(path.join(dir, entry.name));
    else if (entry.isDirectory() && depth > 0)
      findFiles(path.join(dir, entry.name), name, depth - 1, found);
  }
}
