// Where browser sessions put files. Every chat gets its own folder under the
// profile's files directory (subagents get one inside their chat's folder), so
// screenshots, snapshots, downloads, videos and traces never land in the
// project the agent works in. Folders nobody has read or written for a while
// are deleted.
import fs from 'node:fs';
import path from 'node:path';

const marker = '.agentic-browser-session';

export function slug(text: string, max = 40) {
  return text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'session';
}

function shortId(id: string) {
  return id.replace(/^local_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(-8);
}

// <root>/<date>_<title>_<id>. A chat that comes back (resumed, reconnected)
// finds its folder again by the id suffix, even if its title changed.
export function sessionFolder(root: string, id: string, title: string): string {
  const suffix = `_${shortId(id)}`;
  fs.mkdirSync(root, { recursive: true });
  const existing = fs.readdirSync(root).find(name => name.endsWith(suffix) && fs.existsSync(path.join(root, name, marker)));
  const dir = path.join(root, existing ?? `${new Date().toISOString().slice(0, 10)}_${slug(title)}${suffix}`);
  prepare(dir, id);
  return dir;
}

export function subagentFolder(chatDir: string, id: string, description: string): string {
  const dir = path.join(chatDir, `${slug(description, 30)}_${shortId(id)}`);
  prepare(dir, id);
  return dir;
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
