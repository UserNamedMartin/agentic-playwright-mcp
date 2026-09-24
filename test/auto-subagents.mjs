// Automatic subagent detection: fake Claude Code transcripts + calls carrying
// _meta["claudecode/toolUseId"], like Claude Code sends them.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, configDir] = process.argv.slice(2);
const sid = 'sess-' + Date.now();
const dir = path.join(configDir, 'projects', '-tmp-project');
fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
const main = path.join(dir, `${sid}.jsonl`);
fs.writeFileSync(main, '');
const agents = { a1: 'Scrape pricing pages', a2: 'Check docs site' };
for (const [id, description] of Object.entries(agents)) {
  fs.writeFileSync(path.join(dir, sid, 'subagents', `agent-${id}.jsonl`), '');
  fs.writeFileSync(path.join(dir, sid, 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description }));
}
let n = 0;
// Appends the tool_use to the caller's transcript first, as Claude Code does.
const record = file => {
  const id = `toolu_test${++n}`;
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__browser__x', input: {} }] } }) + '\n');
  return id;
};
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: {
  'x-agent-session-id': 'auto-chat', 'x-agent-title': 'Auto chat', 'x-agent-pid': String(process.pid),
  'x-agent-claude-session': sid, 'x-agent-config-dir': encodeURIComponent(configDir),
} } });
const client = new Client({ name: 'auto', version: '1' });
await client.connect(transport);
const call = async (file, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args, _meta: { 'claudecode/toolUseId': record(file) } });
  return res.content.map(c => c.text ?? '').join('\n');
};
const tabUrls = text => text.split('\n').filter(l => /^- \d+: .*\]\(/.test(l)).map(l => l.match(/\]\((.*)\)$/)?.[1]);
const who = async (file, tag) => {
  await call(file, 'browser_navigate', { url: `https://example.com/?who=${tag}` });
  const hrefs = [];
  for (let i = 0; i < 3; i++)
    hrefs.push((await call(file, 'browser_evaluate', { function: '() => location.href' })).match(/who=(\w+)/)?.[1]);
  return { tag, ok: hrefs.every(h => h === tag), tabs: tabUrls(await call(file, 'browser_tabs', { action: 'list' })) };
};
const results = await Promise.all([
  who(main, 'main'),
  who(path.join(dir, sid, 'subagents', 'agent-a1.jsonl'), 'a1'),
  who(path.join(dir, sid, 'subagents', 'agent-a2.jsonl'), 'a2'),
]);
console.log(JSON.stringify(results));
if (process.env.HOLD) await new Promise(r => setTimeout(r, Number(process.env.HOLD)));
await client.close();
process.exit(0);
