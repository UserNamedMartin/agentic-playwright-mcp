// Session file folders: where screenshots, snapshots and downloads land.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const transport = new StreamableHTTPClientTransport(new URL(process.argv[2]), { requestInit: { headers: {
  'x-agent-session-id': 'files-test-12345678', 'x-agent-title': 'Files test', 'x-agent-pid': String(process.pid), 'x-agent-cwd': encodeURIComponent(process.cwd()) } } });
const client = new Client({ name: 'files', version: '1' });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map(c => c.text ?? '').join('\n');
const first = await call('browser_navigate', { url: 'https://example.com/?files=1' });
console.log('first result files note:', first.split('### Files')[1]?.trim().split('\n')[0].slice(0, 160));
console.log('second result has note:', (await call('browser_snapshot', { filename: 'snap.md' })).includes('### Files'));
console.log('screenshot:', (await call('browser_take_screenshot', { filename: 'shots/home.png' })).match(/\[.*?\]\((.*?)\)/)?.[1]);
await call('browser_navigate', { url: 'https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dreport.txt' }).catch(() => {});
await new Promise(r => setTimeout(r, 2000));
console.log('downloads listed:', (await call('browser_tabs', { action: 'list' })).match(/Download[^\n]*/g)?.join(' | ') ?? 'none in tabs output');
await client.close();
process.exit(0);
