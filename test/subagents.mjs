// One session, several "subagents" issuing calls concurrently, each on its own tab.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const transport = new StreamableHTTPClientTransport(new URL(process.argv[2]), {
  requestInit: { headers: { 'x-agent-session-id': 'parent-chat', 'x-agent-title': 'Parent chat', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'subagents', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
const sub = async n => {
  const created = await call('browser_tabs', { action: 'new' });
  const id = created.match(/- \d+: (\w+) \(current\)/)[1];
  await call('browser_navigate', { url: `https://example.com/?sub=${n}`, tab: id });
  const hrefs = [];
  for (let i = 0; i < 4; i++)
    hrefs.push((await call('browser_evaluate', { function: '() => location.href', tab: id })).match(/sub=(\d)/)?.[1]);
  return { n, id, ok: hrefs.every(h => h === String(n)), hrefs };
};
const results = await Promise.all([1, 2, 3, 4].map(sub));
console.log(JSON.stringify(results));
await client.close();
process.exit(0);
