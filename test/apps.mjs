// MCP Apps tab link: protocol checks against a gateway, plus the widget itself
// rendered in a fake host page that speaks the MCP Apps postMessage protocol.
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const [url, cdp] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'x-agent-session-id': 'apps-test', 'x-agent-title': 'Apps test', 'x-agent-pid': String(process.pid) } } });
const client = new Client({ name: 'apps', version: '1' });
await client.connect(transport);
const { tools } = await client.listTools();
const linkTool = tools.find(t => t.name === 'browser_tab_link');
const openTool = tools.find(t => t.name === 'browser_open_tab_window');
console.log('tab_link _meta:', JSON.stringify(linkTool._meta), '| open_tab_window _meta:', JSON.stringify(openTool._meta));
const { resources } = await client.listResources();
const { contents } = await client.readResource({ uri: resources[0].uri });
console.log('resource:', resources[0].uri, contents[0].mimeType, contents[0].text.length, 'chars');
await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com/?app=1' } });
const linkResult = await client.callTool({ name: 'browser_tab_link', arguments: {} });
console.log('structuredContent:', JSON.stringify(linkResult.structuredContent));

// Fake host: render the widget in an iframe, answer ui/initialize, push the tool result, relay tools/call.
const browser = await chromium.connectOverCDP(cdp);
const page = await browser.contexts()[0].newPage();
await page.exposeFunction('relayToolCall', async params => await client.callTool(params));
await page.setContent(`<iframe id=f style="width:600px;height:200px;border:0"></iframe><script>
  window.log = [];
  const f = document.getElementById('f');
  window.addEventListener('message', async e => {
    const m = e.data; window.log.push(m.method || ('response ' + m.id));
    const reply = r => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: r }, '*');
    if (m.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'fake', version: '1' }, hostCapabilities: {}, hostContext: { theme: 'dark' } });
    if (m.method === 'ui/notifications/initialized') f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: ${JSON.stringify(linkResult).replace(/<\//g, '<\\/')} }, '*');
    if (m.method === 'tools/call') { window.toolCall = m.params; reply(await window.relayToolCall(m.params)); }
    if (m.method === 'ui/notifications/size-changed') window.height = m.params.height;
  });
  f.srcdoc = ${JSON.stringify(contents[0].text).replace(/<\//g, '<\\/')};
</script>`);
const frame = page.frameLocator('#f');
await frame.locator('#open:not([disabled])').waitFor({ timeout: 5000 }).catch(async e => {
  console.log('host saw:', JSON.stringify(await page.evaluate(() => window.log)));
  console.log('widget status:', await frame.locator('#status').textContent().catch(() => '?'));
  throw e;
});
console.log('widget shows:', await frame.locator('#title').textContent(), '|', await frame.locator('#url').textContent());
await frame.locator('#open').click();
await page.waitForFunction(() => window.toolCall, null, { timeout: 5000 });
await page.waitForTimeout(500);
console.log('button called:', JSON.stringify(await page.evaluate(() => window.toolCall)), '| status:', JSON.stringify(await frame.locator('#status').textContent()), '| height:', await page.evaluate(() => window.height));
console.log('message flow:', (await page.evaluate(() => window.log)).join(' → '));
await page.close();
await browser.close();
await client.close();
process.exit(0);
