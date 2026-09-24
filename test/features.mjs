// target=_blank interception and subagent sub-sessions, against a running gateway.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const transport = new StreamableHTTPClientTransport(new URL(process.argv[2]), {
  requestInit: { headers: { 'x-agent-session-id': 'feature-chat', 'x-agent-title': 'Feature chat', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'features', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
const tabUrls = text => text.split('\n').filter(l => /^- \d+: .*\]\(/.test(l)).map(l => l.match(/\]\((.*)\)$/)?.[1]);
const out = {};

// 1. target=_blank link opens a background tab owned by this session.
const html = encodeURIComponent('<a id=l href="https://example.com/?from=blank" target="_blank">open</a>');
await call('browser_navigate', { url: `https://httpbin.org/base64/${Buffer.from(decodeURIComponent(html)).toString('base64')}` });
const snap = await call('browser_snapshot');
const ref = snap.match(/link "open" \[ref=(e\d+)\]/)?.[1];
await call('browser_click', { element: 'open link', target: ref });
await new Promise(r => setTimeout(r, 1500));
out.afterBlankClick = tabUrls(await call('browser_tabs', { action: 'list' }));

// 2. Three subagents in parallel, each in its own sub-session.
const sub = async label => {
  const started = await call('browser_subagent_start', { label });
  const agent = started.match(/agent id is "([^"]+)"/)[1];
  await call('browser_navigate', { url: `https://example.com/?sub=${agent}`, agent });
  const hrefs = [];
  for (let i = 0; i < 3; i++)
    hrefs.push((await call('browser_evaluate', { function: '() => location.href', agent })).match(/sub=([\w-]+)/)?.[1]);
  const tabs = tabUrls(await call('browser_tabs', { action: 'list', agent }));
  return { agent, ok: hrefs.every(h => h === agent), tabs };
};
out.subagents = await Promise.all(['pricing research', 'pricing research', 'docs check'].map(sub));
out.mainTabsAfter = tabUrls(await call('browser_tabs', { action: 'list' }));
console.log(JSON.stringify(out, null, 1));
if (process.env.HOLD) await new Promise(r => setTimeout(r, Number(process.env.HOLD)));
await client.close();
process.exit(0);
