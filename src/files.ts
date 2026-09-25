// Where browser sessions put files. Every chat gets its own folder under the
// profile's files directory (subagents get one inside their chat's folder), so
// screenshots, snapshots, downloads, videos and traces never land in the
// project the agent works in. Folders nobody has read or written for a while
// are deleted.
import fs from 'node:fs';
import path from 'node:path';

const marker = '.agentic-browser-session';

// Folders are named after the chat's (or subagent's) id, not its title: titles
// change, ids do not. A folder from an older version with another name is
// still found by the id in its marker file.
function folderName(id: string) {
  return id.replace(/^local_/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'session';
}

export function sessionFolder(root: string, id: string): string {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, existingFolder(root, id) ?? folderName(id));
  prepare(dir, id);
  return dir;
}

export function subagentFolder(chatDir: string, id: string): string {
  const dir = path.join(chatDir, existingFolder(chatDir, id) ?? folderName(id));
  prepare(dir, id);
  return dir;
}

function existingFolder(root: string, id: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  if (names.includes(folderName(id)))
    return folderName(id);
  return names.find(name => {
    try {
      return fs.readFileSync(path.join(root, name, marker), 'utf8').trim() === id;
    } catch {
      return false;
    }
  });
}

function prepare(dir: string, id: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, marker);
  if (!fs.existsSync(file))
    fs.writeFileSync(file, `${id}\n`);
}

// Marks the folder as in use while its session works, even when the session
// writes nothing.
export function touchFolder(dir: string) {
  const now = new Date();
  try {
    fs.utimesSync(path.join(dir, marker), now, now);
  } catch {}
}

// Latest read or write anywhere in the folder. Directories count by mtime
// only: listing them (this scan included) updates their access time.
function lastUse(dir: string): number {
  let latest = 0;
  const visit = (p: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(p);
    } catch {
      return;
    }
    latest = Math.max(latest, stat.mtimeMs, stat.isDirectory() ? 0 : stat.atimeMs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p))
        visit(path.join(p, name));
    }
  };
  visit(dir);
  return latest;
}

// Deletes chat folders (only ones this gateway created) unused for maxAgeMs.
// Folders of sessions that are open right now are kept regardless.
export function cleanFolders(root: string, maxAgeMs: number, inUse: Set<string>): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (inUse.has(dir) || !fs.existsSync(path.join(dir, marker)))
      continue;
    if (Date.now() - lastUse(dir) > maxAgeMs) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
