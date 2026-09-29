// Full MCP regression for Chrome's persistent per-site zoom and our per-tab
// device emulation. Runs in its own headless browser and scratch profile.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-zoom-gateway-'));
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <button id="button" style="position:fixed;left:20px;bottom:20px;width:120px;height:56px"
      onclick="window.clicks=(window.clicks||0)+1">Click</button>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sitePort = server.address().port;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  listener.close();
  return port;
}
const [cdpPort, gatewayPort] = [await freePort(), await freePort()];
let gateway;
let browser;
let client;

try {
  execFileSync(process.execPath, [cli, 'profile', 'add', 'test', '--headless', '--port', String(gatewayPort),
    '--cdp-port', String(cdpPort), '--browser', executable], { env, stdio: 'ignore' });
  // Create valid browser preferences, then make localhost 50% in this scratch
  // profile before the gateway starts its own Chrome process.
  const dataDir = path.join(home, 'profiles', 'test', 'browser-data');
  browser = await chromium.launchPersistentContext(dataDir, { headless: true, executablePath: executable, viewport: null });
  await browser.close();
  browser = undefined;
  const preferencesPath = path.join(dataDir, 'Default', 'Preferences');
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  preferences.partition ??= {};
  preferences.partition.per_host_zoom_levels = {
    x: { localhost: { last_modified: '13435155942698315', zoom_level: -3.8017840169239308 } },
  };
  fs.writeFileSync(preferencesPath, JSON.stringify(preferences));

  gateway = spawn(process.execPath, [cli, 'start', 'test'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  gateway.stderr.on('data', chunk => log += chunk);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    ready = await fetch(`http://127.0.0.1:${gatewayPort}/`).then(response => response.ok, () => false);
    if (ready) break;
    await sleep(200);
  }
  assert(ready, `gateway did not start: ${log.slice(-1000)}`);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': 'zoom-test', 'x-agent-title': 'zoom-test', 'x-agent-pid': String(process.pid) } },
  });
  client = new Client({ name: 'zoom-test', version: '1' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    assert(!result.isError, `${name}: ${result.content.map(block => block.text).join('\n')}`);
    return result.content.map(block => block.text ?? '').join('\n');
  };

  await call('browser_navigate', { url: `http://localhost:${sitePort}/` });
  await call('browser_emulate_device', { device: 'iPhone 15', width: 393, height: 852 });
  const click = `async (page) => { await page.getByRole('button',{name:'Click'}).click({timeout:3000}); return {clicks:await page.evaluate(()=>window.clicks||0),size:await page.evaluate(()=>[innerWidth,innerHeight])}; }`;
  const half = await call('browser_run_code_unsafe', { code: click });
  assert(half.includes('"clicks":1') && half.includes('[393,852]'), half);

  // The browser keeps the emulated tab while navigating to a host whose zoom
  // is 100%. The worker must refresh the CDP scale before the next click.
  await call('browser_navigate', { url: `http://127.0.0.1:${sitePort}/` });
  const full = await call('browser_run_code_unsafe', { code: click });
  assert(full.includes('"clicks":1') && full.includes('[393,852]'), full);
  console.log('ok: MCP clicks at 50% zoom and refreshes after navigation to 100% zoom');
} finally {
  await client?.close().catch(() => {});
  await browser?.close().catch(() => {});
  gateway?.kill('SIGINT');
  await sleep(1000);
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
}
