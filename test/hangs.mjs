// Calls that never finish must not block a session: a cancelled call and a
// call past its timeout free the queue at once, and a call that had to wait
// behind another says so.
//
// Usage: node test/hangs.mjs [browser executable]
//
// Self-contained and headless: its own browser, gateway and scratch
// AGENTIC_PLAYWRIGHT_HOME. Prints one line per check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-hangs-'));
const [cdpPort, gatewayPort] = [19371, 19372];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const run = (...args) => spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
await new Promise(r => run('profile', 'add', 'test', '--headless', '--port', String(gatewayPort), '--cdp-port', String(cdpPort), '--browser', executable).on('exit', r));
const gateway = run('start', 'test');
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${gatewayPort}/`).then(r => r.ok, () => false))
    break;
  await sleep(200);
}

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
  requestInit: { headers: { 'x-agent-session-id': 'hangs-chat', 'x-agent-title': 'Hangs', 'x-agent-pid': String(process.pid) } },
});
const client = new Client({ name: 'hangs-test', version: '1' });
await client.connect(transport);
const text = result => result.content.map(c => c.text ?? '').join('\n');
const call = async (name, args = {}, options = {}) => text(await client.callTool({ name, arguments: args }, undefined, { timeout: 600000, ...options }));
const never = '() => new Promise(() => {})';
// A quick call, raced against a deadline: a blocked session never answers.
const quick = async () => {
  const started = Date.now();
  const answer = await Promise.race([call('browser_evaluate', { function: '() => 1 + 1' }), sleep(8000).then(() => 'no answer')]);
  return { answered: /### Result\n2/.test(answer), ms: Date.now() - started, answer };
};

try {
  await call('browser_navigate', { url: 'data:text/html,<title>hangs</title>' });

  const schema = (await client.listTools()).tools.find(t => t.name === 'browser_evaluate');
  check('tools take a timeout', schema?.inputSchema.properties?.timeout?.type === 'number');

  const cancel = new AbortController();
  const cancelled = call('browser_evaluate', { function: never }, { signal: cancel.signal }).then(() => 'resolved', e => `rejected: ${e.message}`);
  await sleep(1000);
  cancel.abort('agent interrupted');
  check('cancelled call is rejected', /rejected/.test(await cancelled), await cancelled);
  const afterCancel = await quick();
  check('next call runs after a cancel', afterCancel.answered && afterCancel.ms < 3000, `${afterCancel.ms} ms`);

  const started = Date.now();
  const timedOut = await call('browser_evaluate', { function: never, timeout: 2 });
  const took = Date.now() - started;
  check('hung call given up at its timeout', /did not finish within 2 s/.test(timedOut) && took < 5000, `${took} ms`);
  const afterTimeout = await quick();
  check('next call runs after a timeout', afterTimeout.answered && afterTimeout.ms < 3000, `${afterTimeout.ms} ms`);

  const longer = await call('browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r("slow done"), 3000))', timeout: 10 });
  check('a raised timeout lets a slow call finish', /slow done/.test(longer));

  const huge = await call('browser_evaluate', { function: '() => 1 + 1', timeout: 1e10 });
  check('a huge timeout is not an overflow (given up at once)', /### Result\n2/.test(huge), huge);

  // A call given up that finishes later must not move the agent back to the
  // tab it ran on once the agent has switched tabs.
  await call('browser_navigate', { url: 'data:text/html,<title>t1</title>' });
  await call('browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r(1), 4000))', timeout: 1 });
  await call('browser_tabs', { action: 'new', url: 'data:text/html,<title>t2</title>' });
  await sleep(4000);
  const where = await call('browser_evaluate', { function: '() => document.title' });
  check('a late given-up call leaves the tab the agent switched to', /"t2"/.test(where), where.split('\n').slice(0, 2).join(' '));
  await call('browser_tabs', { action: 'close' });
  await call('browser_tabs', { action: 'select', index: 0 });

  const slow = call('browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r("slow"), 3000))' });
  await sleep(200);
  const waiting = await call('browser_evaluate', { function: '() => 1 + 1' });
  await slow;
  check('a queued call says it waited', /### Queue\nThis call waited \d+ s for your previous call \(browser_evaluate\)/.test(waiting),
    waiting.split('### Queue\n')[1]?.split('\n')[0]);
  const alone = await call('browser_evaluate', { function: '() => 1 + 1' });
  check('a call that did not wait says nothing', !alone.includes('### Queue'));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}`);
} finally {
  gateway.kill('SIGINT');
  await sleep(1500);
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}
