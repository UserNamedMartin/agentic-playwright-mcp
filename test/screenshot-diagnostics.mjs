// Screenshot CDP diagnostics: a reply, a slow/no-reply command, and a closed
// connection. The fake clock keeps the timeout checks immediate and exact.
import assert from 'node:assert/strict';
import { ScreenshotDiagnostics } from '../dist/screenshot-diagnostics.js';

let now = 0;
const timers = [];
const clock = {
  now: () => now,
  after(fn, ms) {
    const timer = { at: now + ms, fn, active: true };
    timers.push(timer);
    return timer;
  },
  cancel(timer) { timer.active = false; },
};
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const next = timers.filter(t => t.active && t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    now = next.at;
    next.active = false;
    next.fn();
  }
  now = end;
}

const lines = [];
const d = new ScreenshotDiagnostics({
  session: 'test-session', log: line => lines.push(line), clock,
  slowMs: 5, noReplyMs: 30, forgetMs: 60,
});

d.start('page-1', 7, 'ABCDEF123456', 'hidden');
advance(3);
assert.equal(d.finish('page-1', 7), true);
assert.match(lines[0], /Page\.captureScreenshot sent.*tab=ABCDEF12.*window=hidden/);
assert.match(lines[1], /Page\.captureScreenshot reply.*3 ms.*ok/);
advance(40);
assert.equal(lines.length, 2, 'finished calls leave no timeout timers');

d.start('page-2', 8, '123456ABCDEF', 'visible');
advance(5);
assert.match(lines.at(-1), /Page\.captureScreenshot waiting.*5 ms/);
advance(25);
assert.match(lines.at(-1), /Page\.captureScreenshot no reply.*30 ms/);
advance(10);
assert.equal(d.finish('page-2', 8), true, 'a late reply is still logged');
assert.match(lines.at(-1), /Page\.captureScreenshot reply.*40 ms.*ok/);

d.start('page-5', 11, '778899AABBCC', 'hidden');
advance(60);
assert.match(lines.at(-1), /Page\.captureScreenshot forgotten.*60 ms/);
assert.equal(d.finish('page-5', 11), false, 'forgotten calls release their state');

d.start('page-3', 9, 'FEDCBA654321', 'unknown');
advance(2);
d.finish('page-3', 9, { code: -32000, message: 'secret payload' });
assert.match(lines.at(-1), /Page\.captureScreenshot reply.*error=-32000/);
assert.ok(!lines.join('\n').includes('secret payload'), 'CDP error text is not logged');

d.start('page-4', 10, '112233445566', 'hidden');
advance(2);
d.close();
assert.match(lines.at(-1), /Page\.captureScreenshot connection closed.*2 ms/);
advance(40);
assert.equal(lines.filter(x => /no reply/.test(x)).length, 2, 'closed calls leave no timeout timers');

console.log('screenshot diagnostics passed');
