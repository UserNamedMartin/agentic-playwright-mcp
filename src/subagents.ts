// Automatic subagent detection for Claude Code. Every tools/call carries the
// id of the tool_use block that made it (_meta["claudecode/toolUseId"]), and
// Claude Code appends that block to the caller's transcript before running the
// tool: the main agent's to <session>.jsonl, each subagent's to
// <session>/subagents/agent-<id>.jsonl (with agent-<id>.meta.json holding its
// description). Indexing those files tells the gateway which agent is calling,
// so subagents get their own tab group without having to do anything.
import fs from 'node:fs';
import path from 'node:path';

export type Caller = { kind: 'main' } | { kind: 'subagent'; agentId: string; description: string };

export class TranscriptIndex {
  private _configDir: string;
  private _sessionId: string;
  private _dir: string | undefined;
  private _offsets = new Map<string, number>();
  private _callers = new Map<string, Caller>();
  private _descriptions = new Map<string, string>();
  private _customTitle: string | undefined;

  constructor(configDir: string, sessionId: string) {
    this._configDir = configDir;
    this._sessionId = sessionId;
  }

  async lookup(toolUseId: string): Promise<Caller | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      this._scan();
      const caller = this._callers.get(toolUseId);
      if (caller)
        return caller;
      await new Promise(r => setTimeout(r, 50));
    }
    return undefined;
  }

  // The chat's title as set with /rename in the Claude Code CLI, if any.
  customTitle(): string | undefined {
    this._scan();
    return this._customTitle;
  }

  private _scan() {
    const dir = this._findDir();
    if (!dir)
      return;
    this._scanFile(path.join(dir, `${this._sessionId}.jsonl`), { kind: 'main' });
    const subagentsDir = path.join(dir, this._sessionId, 'subagents');
    let files: string[] = [];
    try {
      files = fs.readdirSync(subagentsDir);
    } catch {
      return;
    }
    for (const file of files) {
      const match = file.match(/^agent-(.+)\.jsonl$/);
      if (!match)
        continue;
      const agentId = match[1];
      this._scanFile(path.join(subagentsDir, file), { kind: 'subagent', agentId, description: this._description(subagentsDir, agentId) });
    }
  }

  // Reads only what was appended since the last scan, up to the last full line.
  private _scanFile(file: string, caller: Caller) {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const offset = this._offsets.get(file) ?? 0;
    if (size <= offset)
      return;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < 0)
        return;
      const text = buffer.subarray(0, lastNewline + 1).toString('utf8');
      for (const line of text.split('\n')) {
        if (caller.kind === 'main' && line.includes('"custom-title"'))
          this._customTitle = customTitle(line) ?? this._customTitle;
        if (!line.includes('"tool_use"'))
          continue;
        for (const id of toolUseIds(line)) {
          // A subagent attribution always wins over the main transcript.
          if (caller.kind === 'main' && this._callers.get(id)?.kind === 'subagent')
            continue;
          this._callers.set(id, caller);
        }
      }
      this._offsets.set(file, offset + lastNewline + 1);
    } finally {
      fs.closeSync(fd);
    }
  }

  private _description(subagentsDir: string, agentId: string) {
    let description = this._descriptions.get(agentId);
    if (description)
      return description;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), 'utf8'));
      description = meta.description || meta.agentType;
    } catch {}
    description ||= `subagent ${agentId.slice(0, 6)}`;
    this._descriptions.set(agentId, description);
    return description;
  }

  // <configDir>/projects/<project>/<sessionId>.jsonl; the project folder is
  // derived from the session's original cwd, so search for it once.
  private _findDir() {
    if (this._dir)
      return this._dir;
    const projects = path.join(this._configDir, 'projects');
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(projects);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (fs.existsSync(path.join(projects, entry, `${this._sessionId}.jsonl`)))
        return this._dir = path.join(projects, entry);
    }
    return undefined;
  }
}

function toolUseIds(line: string): string[] {
  try {
    const entry = JSON.parse(line);
    const content = entry?.type === 'assistant' ? entry.message?.content : undefined;
    return Array.isArray(content) ? content.filter((b: any) => b?.type === 'tool_use' && typeof b.id === 'string').map((b: any) => b.id) : [];
  } catch {
    return [];
  }
}

function customTitle(line: string): string | undefined {
  try {
    const entry = JSON.parse(line);
    return entry?.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim() ? entry.customTitle.trim() : undefined;
  } catch {
    return undefined;
  }
}
