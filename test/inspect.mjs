// Prints tab groups and tabs of a profile's browser (via the companion extension).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP(process.argv[2]);
const ctx = browser.contexts()[0];
let sw;
for (const w of ctx.serviceWorkers())
  if (await w.evaluate(() => typeof self.apmPing === 'function').catch(() => false)) sw = w;
const state = await sw.evaluate(async () => {
  const groups = await chrome.tabGroups.query({});
  const tabs = await chrome.tabs.query({});
  return { groups: groups.map(g => ({ id: g.id, title: g.title, color: g.color, tabs: tabs.filter(t => t.groupId === g.id).map(t => t.url) })),
           ungrouped: tabs.filter(t => t.groupId === -1).map(t => (t.pinned ? '[pinned] ' : '') + t.url) };
});
console.log(JSON.stringify(state, null, 1));
await browser.close();
