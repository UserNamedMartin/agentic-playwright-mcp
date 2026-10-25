// Automatic subagent detection for Claude Code. Every tools/call carries the
// id of the tool_use block that made it (_meta["claudecode/toolUseId"]), and
// Claude Code appends that block to the caller's transcript: the main agent's
// to <session>.jsonl, each subagent's to <session>/subagents/agent-<id>.jsonl
// (with agent-<id>.meta.json holding its description). Indexing those files
// tells the gateway which agent is calling, so subagents get their own tab
// group without having to do anything.
//
// The line is written asynchronously and often reaches the disk after the
// call has arrived (measured with Claude Code 2.1.267: 0.1-1 s, the first call
// of a parallel batch slowest). So a lookup waits for it while any subagent may
// be calling; giving up early sent subagents' calls to the parent chat.
import fs from 'node:fs';
import path from 'node:path';

const scanChunkBytes = 4 * 1024 * 1024;
// Tool calls remembered per chat; a lookup is for a call made just now.
const maxCallers = 5000;
// While subagents are alive, a call waits this long for its tool_use line.
const liveSubagentWaitMs = 5000;
// Without live subagents only the chat itself can be calling.
const quickWaitMs = 250;
const rescanMs = 25;
// A subagent whose transcript was written this recently may still be calling
// (subagents write their transcript on every turn).
const subagentAliveMs = 10 * 60 * 1000;

export type Caller = { kind: 'main' } | { kind: 'subagent'; agentId: string; description: string };

export class TranscriptIndex {
  private _configDir: string;
  private _sessionId: string;
  private _dir: string | undefined;
  private _offsets = new Map<string, number>();
  private _callers = new Map<string, Caller>();
  private _descriptions = new Map<string, string>();
  private _customTitle: string | undefined;
  private _scanning: Promise<void> | undefined;
  private _newestSubagentWrite = 0;

  private _onTitleChange: (() => void) | undefined;

  // onTitleChange: a /rename was found by a background scan.
  constructor(configDir: string, sessionId: string, onTitleChange?: () => void) {
    this._configDir = configDir;
    this._sessionId = sessionId;
    this._onTitleChange = onTitleChange;
  }

  // Waits for the call's tool_use line; a found id answers at once, so the
  // chat's own calls wait only for the write itself.
  async lookup(toolUseId: string): Promise<Caller | undefined> {
    const start = Date.now();
    for (;;) {
      await this._scanSoon();
      const caller = this._callers.get(toolUseId);
      if (caller)
        return caller;
      if (Date.now() - start >= (this.subagentsAlive() ? liveSubagentWaitMs : quickWaitMs))
        return undefined;
      await new Promise(r => setTimeout(r, rescanMs));
    }
  }

  // Whether a subagent of this chat wrote its transcript recently.
  subagentsAlive(): boolean {
    return Date.now() - this._newestSubagentWrite < subagentAliveMs;
  }

  // The chat's title as set with /rename in the Claude Code CLI, if any.
  // Returns what is known now; a scan for newer lines starts in the
  // background and the next call sees its result.
  customTitle(): string | undefined {
    void this._scanSoon().catch(() => {});
    return this._customTitle;
  }

  // One scan at a time; callers during a scan wait for it.
  private _scanSoon(): Promise<void> {
    const before = this._customTitle;
    return this._scanning ??= this._scan().finally(() => {
      this._trim();
      this._scanning = undefined;
      if (this._customTitle !== before)
        this._onTitleChange?.();
    });
  }

  private async _scan() {
    const dir = this._findDir();
    if (!dir)
      return;
    await this._scanFile(path.join(dir, `${this._sessionId}.jsonl`), { kind: 'main' });
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
      await this._scanFile(path.join(subagentsDir, file), { kind: 'subagent', agentId, description: this._description(subagentsDir, agentId) });
    }
  }

  // Reads only what was appended since the last scan, up to the last full
  // line, in chunks and without blocking: long chats have transcripts of
  // 100 MB and more, and every session shares this process.
  private async _scanFile(file: string, caller: Caller) {
    let size: number;
    try {
      const stat = await fs.promises.stat(file);
      size = stat.size;
      if (caller.kind === 'subagent')
        this._newestSubagentWrite = Math.max(this._newestSubagentWrite, stat.mtimeMs);
    } catch {
      return;
    }
    let offset = this._offsets.get(file) ?? 0;
    if (size <= offset)
      return;
    const handle = await fs.promises.open(file, 'r');
    try {
      let carry = Buffer.alloc(0);
      while (offset + carry.length < size) {
        const chunk = Buffer.alloc(Math.min(scanChunkBytes, size - offset - carry.length));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset + carry.length);
        if (!bytesRead)
          break;
        const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          carry = data;
          continue;
        }
        this._indexLines(data.subarray(0, lastNewline + 1).toString('utf8'), caller);
        offset += lastNewline + 1;
        this._offsets.set(file, offset);
        carry = data.subarray(lastNewline + 1);
      }
    } finally {
      await handle.close();
    }
  }

  // Ids indexed by the scan running now: a pending lookup is for one of them.
  private _fresh = new Set<string>();

  private _indexLines(text: string, caller: Caller) {
    for (const line of text.split('\n')) {
      if (caller.kind === 'main' && line.includes('"custom-title"'))
        this._customTitle = customTitle(line) ?? this._customTitle;
      if (!line.includes('"tool_use"'))
        continue;
      for (const id of toolUseIds(line)) {
        // A subagent attribution always wins over the main transcript.
        if (caller.kind === 'main' && this._callers.get(id)?.kind === 'subagent')
          continue;
        this._callers.delete(id);
        this._callers.set(id, caller);
        this._fresh.add(id);
      }
    }
  }

  // Lookups are for calls being made now: after a scan, the oldest ids can
  // go, never those this scan found.
  private _trim() {
    for (const id of this._callers.keys()) {
      if (this._callers.size <= maxCallers)
        break;
      if (!this._fresh.has(id))
        this._callers.delete(id);
    }
    this._fresh.clear();
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
