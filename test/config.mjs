// Playwright MCP config options reach the gateway: from a config file (the
// profile's "config" / start --config) and from PLAYWRIGHT_MCP_* variables.
//
// Usage: node test/config.mjs [browser executable]
//
// Self-contained and headless: its own browsers, gateways, site and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-config-'));
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
};

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>page</title><input data-qa="name-field" aria-label="name"><button id=hidden style="display:none">hidden</button>`);
}).listen(0, '127.0.0.1');
await new Promise(r => site.on('listening', r));
const port = site.address().port;

async function withGateway(name, [cdpPort, gatewayPort], { config, env = {} }, body) {
  const envAll = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: path.join(home, name), ...env };
  const run = (...args) => spawn(process.execPath, [cli, ...args], { env: envAll, stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable,
    ...(config ? ['--config', config] : [])).on('exit', r));
  const gateway = run('start', 'test');
  for (let i = 0; i < 150; i++) {
    if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
      break;
    await sleep(200);
  }
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { 'x-agent-session-id': name, 'x-agent-title': name, 'x-agent-pid': String(process.pid) } },
  });
  const client = new Client({ name, version: '1' });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const started = Date.now();
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    return { text: r.content.map(c => c.text ?? '').join('\n'), isError: !!r.isError, ms: Date.now() - started };
  };
  try {
    await body(call, client, `http://127.0.0.1:${gatewayPort}`);
  } finally {
    gateway.kill('SIGINT');
    await sleep(1500);
  }
}

try {
  // A config file.
  fs.writeFileSync(path.join(home, 'init.js'), 'window.__initRan = "yes";');
  const configFile = path.join(home, 'mcp-config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    browser: { initScript: ['init.js'] },
    network: { blockedOrigins: [`http://localhost:${port}`] },
    testIdAttribute: 'data-qa',
    secrets: { MY_SECRET: 'hunter2' },
    timeouts: { action: 1500 },
  }));
  await withGateway('file', [19441, 19442], { config: configFile }, async (call, client) => {
    const tools = (await client.listTools()).tools.map(t => t.name);
    check('default capabilities kept', tools.includes('browser_mouse_click_xy') && tools.includes('browser_start_tracing'));
    await call('browser_navigate', { url: `http://127.0.0.1:${port}/` });
    const init = await call('browser_evaluate', { function: '() => window.__initRan' });
    check('initScript runs in pages', init.text.includes('"yes"'), init.text);
    const snapshot = await call('browser_snapshot');
    const ref = snapshot.text.match(/textbox "name"[^\n]*\[ref=(\w+)\]/)?.[1];
    const locator = await call('browser_generate_locator', { element: 'name', target: ref ?? 'missing-ref' });
    check('testIdAttribute used for locators', /getByTestId\(['"]name-field['"]\)/.test(locator.text), ref ? locator.text : snapshot.text.slice(0, 300));
    await call('browser_type', { element: 'name', target: '[data-qa="name-field"]', text: 'MY_SECRET' });
    const typed = await call('browser_evaluate', { function: '() => document.querySelector("[data-qa]").value' });
    // The value is hunter2; results show it redacted as the secret's name.
    check('secrets are filled in', typed.text.includes('<secret>MY_SECRET</secret>') && !typed.text.includes('hunter2'), typed.text);
    const slow = await call('browser_click', { element: 'hidden', target: '#hidden' });
    check('action timeout from the config', slow.isError && slow.ms < 4000, `${slow.ms} ms`);
    // Last: the tab is left on Chrome's error page.
    const blocked = await call('browser_navigate', { url: `http://localhost:${port}/` });
    check('blocked origin is blocked', blocked.isError || /ERR_BLOCKED_BY_CLIENT/.test(blocked.text), blocked.text);
  });

  // PLAYWRIGHT_MCP_* variables, and allowed origins.
  await withGateway('env', [19443, 19444], { env: { PLAYWRIGHT_MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` } }, async (call, _client, gatewayUrl) => {
    const allowed = await call('browser_navigate', { url: `http://127.0.0.1:${port}/` });
    check('allowed origin loads', !allowed.isError && allowed.text.includes('page'), allowed.text);
    const status = await call('browser_navigate', { url: `${gatewayUrl}/` });
    check('the gateway\'s status page is not for agents (blocked, not allowed by the list)', status.isError && /ERR_BLOCKED_BY_CLIENT/.test(status.text), status.text);
    const other = await call('browser_navigate', { url: `http://localhost:${port}/` });
    check('other origins are blocked', other.isError || /ERR_BLOCKED_BY_CLIENT/.test(other.text), other.text);
  });
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  site.close();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
