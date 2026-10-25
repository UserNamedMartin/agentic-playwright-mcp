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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const executable = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-hangs-'));
const [cdpPort, gatewayPort] = [19371, 19372];
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'cli.js');
// Silent tabs are closed after 12 s here (60 s otherwise).
const env = { ...process.env, AGENTIC_PLAYWRIGHT_HOME: home, AGENTIC_SILENT_TAB_CLOSE_MS: '12000' };
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
  // ... also when it finishes in the middle of the agent's next call.
  const ids = (await call('browser_tabs', { action: 'new', url: 'data:text/html,<title>t2</title>' })).match(/- \d+: ([0-9A-F]{8})/g).map(l => l.split(': ')[1]);
  await call('browser_tabs', { action: 'select', index: 0 });
  await call('browser_evaluate', { function: '() => new Promise(r => setTimeout(() => r(1), 2500))', timeout: 1 });
  await call('browser_wait_for', { time: 3, tab: ids[1] });
  const where2 = await call('browser_evaluate', { function: '() => document.title' });
  check('... also when it finishes during the next call', /"t2"/.test(where2), where2.split('\n').slice(0, 2).join(' '));
  await call('browser_tabs', { action: 'close', index: 1 });
  await call('browser_tabs', { action: 'select', index: 0 });

  // Agent code given up at its timeout must stop: a polling loop in run_code
  // kept hammering a site for half an hour after "gave up" (live, 2026-10-25).
  const counter = '() => window.__n || 0';
  await call('browser_evaluate', { function: '() => { window.__n = 0; }' });
  const loop = `async (page) => { for (;;) { await page.evaluate(() => { window.__n = (window.__n || 0) + 1; }); await page.waitForTimeout(100); } }`;
  const gaveUp = await call('browser_run_code_unsafe', { code: loop, timeout: 2 });
  await sleep(500);
  const n1 = Number((await call('browser_evaluate', { function: counter })).match(/### Result\n(\d+)/)?.[1]);
  await sleep(1500);
  const n2 = Number((await call('browser_evaluate', { function: counter })).match(/### Result\n(\d+)/)?.[1]);
  check('run_code given up at its timeout stops running', /did not finish within 2 s/.test(gaveUp) && n1 > 0 && n1 === n2, `counter ${n1} -> ${n2}`);
  check('... and says its code was stopped', /code was stopped/.test(gaveUp), gaveUp.split('\n')[0]);
  const cancelCode = new AbortController();
  const cancelledCode = call('browser_run_code_unsafe', { code: loop }, { signal: cancelCode.signal }).catch(() => {});
  await sleep(1000);
  cancelCode.abort('agent interrupted');
  await cancelledCode;
  await sleep(500);
  const c1 = Number((await call('browser_evaluate', { function: counter })).match(/### Result\n(\d+)/)?.[1]);
  await sleep(1500);
  const c2 = Number((await call('browser_evaluate', { function: counter })).match(/### Result\n(\d+)/)?.[1]);
  check('cancelled run_code stops running', c1 > n2 && c1 === c2, `counter ${c1} -> ${c2}`);
  const tabsLeft = await call('browser_tabs', { action: 'list' });
  check('tabs survive stopping the code', /hangs|t1/.test(tabsLeft), tabsLeft.split('\n').slice(0, 3).join(' '));

  // A tab stuck in a script kept a new thread from connecting: every call of
  // the session failed with connectOverCDP's timeout, closing that tab too.
  // The proxy leaves a silent tab out until it answers, brings back one that
  // recovers, closes one that stays silent; a dialog left open is dismissed.
  // Different sites, so the pages get their own renderer processes (two
  // data: pages shared one, and the loop froze the dialog page too).
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const t = new URL(req.url, 'http://x').searchParams.get('t');
    // A page that answers, with a cross-site (out-of-process) frame stuck in a loop.
    if (t === 'framed')
      res.end(`<title>framed</title><iframe src="http://localhost:${port}/?t=frameloop"></iframe>`);
    else if (t === 'frameloop')
      res.end('<script>setTimeout(() => { for (;;) {} }, 300)</script>');
    else
      res.end(`<title>${t}</title>`);
  }).listen(0, '::');
  await new Promise(r => site.on('listening', r));
  const port = site.address().port;
  const listTitles = text => (text.split('### Result')[1] ?? '').split('###')[0];
  await call('browser_tabs', { action: 'new', url: `http://127.0.0.1:${port}/?t=dialog` });
  await call('browser_evaluate', { function: '() => { setTimeout(() => alert("hi"), 100); return 1; }' });
  await sleep(500);
  await call('browser_tabs', { action: 'new', url: `http://localhost:${port}/?t=stuck` });
  await call('browser_evaluate', { function: '() => { setTimeout(() => { for (;;) {} }, 200); return 1; }', timeout: 3 });
  await call('browser_tabs', { action: 'new', url: `http://[::1]:${port}/?t=busy` });
  await call('browser_evaluate', { function: '() => { setTimeout(() => { const end = Date.now() + 9000; while (Date.now() < end) {} }, 200); return 1; }', timeout: 1 });
  await sleep(800);
  await call('browser_run_code_unsafe', { code: 'async () => new Promise(() => {})', timeout: 1 });
  const restartedAt = Date.now();
  const afterStuck = await call('browser_tabs', { action: 'list' });
  const restartMs = Date.now() - restartedAt;
  check('a stuck tab does not keep the session from reconnecting', restartMs < 6000 && !/connectOverCDP/.test(afterStuck), `${restartMs} ms`);
  check('... it is left out and the agent told', /### Tab not responding/.test(afterStuck) && !/\[stuck\]/.test(listTitles(afterStuck)),
    afterStuck.split('### Tab not responding\n')[1]?.split('\n')[0]?.slice(0, 100));
  check('... a dialog left open is dismissed and the agent told', /### Dialog dismissed\nThe alert dialog "hi"/.test(afterStuck),
    afterStuck.split('### Dialog dismissed\n')[1]?.split('\n')[0]?.slice(0, 120));
  check('... tabs that answer stay, the dialog tab included, in their order',
    /\[t1\][\s\S]*\[dialog\]/.test(listTitles(afterStuck)), listTitles(afterStuck).replace(/\n/g, ' ').slice(0, 200));
  await sleep(8000);
  const recovered = await call('browser_tabs', { action: 'list' });
  check('a tab that was only busy comes back', /\[busy\]/.test(listTitles(recovered)) && /### Tab back/.test(recovered),
    listTitles(recovered).replace(/\n/g, ' ').slice(0, 200));
  await sleep(5000);
  const closedLater = await call('browser_tabs', { action: 'list' });
  check('a tab silent past the limit is closed and the agent told', /### Closed tabs/.test(closedLater) && !/\[stuck\]/.test(listTitles(closedLater)),
    closedLater.split('### Closed tabs\n')[1]?.split('\n')[0]?.slice(0, 100));
  // A page that answers with a stuck out-of-process frame is not silent: it
  // stays in the list across a reconnect, and the reconnect is not held up.
  await call('browser_tabs', { action: 'new', url: `http://127.0.0.1:${port}/?t=framed` });
  await sleep(1000);
  await call('browser_run_code_unsafe', { code: 'async () => new Promise(() => {})', timeout: 1 });
  const framedAt = Date.now();
  const framedList = await call('browser_tabs', { action: 'list' });
  check('a stuck out-of-process frame neither holds up a reconnect nor hides its page',
    Date.now() - framedAt < 4000 && /\[framed\]/.test(listTitles(framedList)), `${Date.now() - framedAt} ms; ${listTitles(framedList).replace(/\n/g, ' ').slice(0, 160)}`);
  await call('browser_tabs', { action: 'select', index: 0 }).catch(() => {});
  site.close();

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
