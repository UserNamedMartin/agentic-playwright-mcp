// Usage: node test/e2e-client.mjs <gatewayUrl> <sessionId> <title>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, id, title] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { 'x-agent-session-id': id, 'x-agent-title': encodeURIComponent(title), 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'e2e', version: '1' });
await client.connect(transport);
const text = r => r.content.map(c => c.text ?? '').join('\n');
const call = async (name, args = {}) => text(await client.callTool({ name, arguments: args }));
const out = { id, errors: [] };
const t0 = Date.now();
try {
  out.toolCount = (await client.listTools()).tools.length;
  await call('browser_navigate', { url: `https://httpbin.org/forms/post?agent=${id}` });
  const snap = await call('browser_snapshot');
  const ref = snap.match(/checkbox "Bacon"[^\n]*\[ref=(e\d+)\]/)?.[1];
  if (!ref) out.errors.push('no bacon ref');
  else await call('browser_click', { element: 'Bacon checkbox', target: ref });
  out.checked = (await call('browser_evaluate', { function: '() => document.querySelector("input[value=bacon]").checked' })).includes('true');
  if (!process.env.NO_POPUP) await call('browser_evaluate', { function: `() => { window.open('https://example.com/?agent=${id}&popup=1'); }` });
  await new Promise(r => setTimeout(r, 1500));
  await call('browser_tabs', { action: 'new' });
  await call('browser_navigate', { url: `https://example.com/?agent=${id}&tab=2` });
  const tabs = await call('browser_tabs', { action: 'list' });
  const tabLines = tabs.split('\n').filter(l => /^- \d+: .*\]\(/.test(l));
  out.tabCount = tabLines.length; out.tabLines = tabLines;
  out.onlyOwnTabs = tabLines.every(l => l.includes(`agent=${id}`));
  out.link = (await call('browser_tab_link')).match(/http\S+/)?.[0];
  out.emulate = (await call('browser_emulate_device', { device: 'iPhone 15' })).split('\n')[1] ?? '';
  out.innerWidth = (await call('browser_evaluate', { function: '() => innerWidth' })).match(/\n(\d+)/)?.[1];
} catch (e) {
  out.errors.push(String(e));
}
out.ms = Date.now() - t0;
console.log(JSON.stringify(out));
if (process.env.HOLD) await new Promise(r => setTimeout(r, Number(process.env.HOLD)));
await client.close();
process.exit(0);
