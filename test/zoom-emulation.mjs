// Regression: a Chrome site zoom must not move clicks when device emulation is
// applied through CDP. Self-contained and headless; never touches the user's
// persistent browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { applyEmulation } from '../dist/tools.js';

const executablePath = process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-zoom-emulation-'));
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
  <button id="button" style="position:fixed;left:20px;bottom:20px;width:120px;height:56px"
    onclick="window.clicks=(window.clicks||0)+1">Click</button>
  <script>window.points=[];document.addEventListener('pointerdown',e=>points.push([e.clientX,e.clientY]))</script>`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const options = { headless: true, executablePath, viewport: null };
let context;

async function clickAtButton(page) {
  const point = await page.locator('#button').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  });
  await page.mouse.click(...point);
  const actual = await page.evaluate(() => window.points.at(-1));
  assert.deepEqual(actual, point, `click at ${point} reached ${actual}`);
  assert.equal(await page.evaluate(() => window.clicks), 1);
}

try {
  // Let Chrome create a valid profile, then set only this scratch profile's
  // localhost zoom to 50% (Chrome's discrete -3.80178 zoom level).
  context = await chromium.launchPersistentContext(home, options);
  await context.close();
  const preferencesPath = path.join(home, 'Default', 'Preferences');
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  preferences.partition ??= {};
  preferences.partition.per_host_zoom_levels = {
    x: { localhost: { last_modified: '13435155942698315', zoom_level: -3.8017840169239308 } },
  };
  fs.writeFileSync(preferencesPath, JSON.stringify(preferences));

  context = await chromium.launchPersistentContext(home, options);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`http://localhost:${port}/`);
  assert.equal(await page.evaluate(() => devicePixelRatio), 0.5);
  await clickAtButton(page); // Stock Playwright alone handles site zoom.

  await page.evaluate(() => { window.points = []; window.clicks = 0; });
  await applyEmulation(page, { width: 393, height: 852, mobile: true, deviceScaleFactor: 3, touch: true, zoom: 0.5 });
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [393, 852]);
  await clickAtButton(page); // Before the fix this arrived at half the coordinates.
  const screenshot = await page.screenshot({ scale: 'css' });
  assert.deepEqual([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)], [393, 852]);

  // A navigation may change the site's zoom. Reapplying the new value keeps
  // the same emulated viewport and correct coordinates.
  await page.goto(`http://127.0.0.1:${port}/`);
  await applyEmulation(page, { width: 393, height: 852, mobile: true, deviceScaleFactor: 3, touch: true, zoom: 1 });
  await clickAtButton(page);
  console.log('ok: device emulation preserves click coordinates at 50% and 100% site zoom');
} finally {
  await context?.close().catch(() => {});
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
}
