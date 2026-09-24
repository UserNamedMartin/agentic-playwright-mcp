// Records what happens on screen after a link is opened the way a chat app does:
// front app, agent window state and bounds, every 50 ms.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const [cdpUrl, link, ms = '5000'] = process.argv.slice(2);
const front = () => { try { const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim(); return execFileSync('lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8' }).split('=')[1]?.trim(); } catch { return '?'; } };
const browser = await chromium.connectOverCDP(cdpUrl);
const cdp = await browser.newBrowserCDPSession();
const { targetInfos } = await cdp.send('Target.getTargets');
const home = targetInfos.find(t => t.type === 'page');
const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: home.targetId });
const state = async () => { const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId }); return `${bounds.windowState} @${bounds.left},${bounds.top} ${bounds.width}x${bounds.height}`; };
const log = []; let last = '';
const t0 = Date.now();
spawn('open', [...(process.env.OPEN_ARGS ? process.env.OPEN_ARGS.split(' ') : []), link], { stdio: 'ignore' });
while (Date.now() - t0 < Number(ms)) {
  const line = `${front()} | ${await state()}`;
  if (line !== last) { log.push(`${String(Date.now() - t0).padStart(5)}ms ${line}`); last = line; }
  await new Promise(r => setTimeout(r, 50));
}
console.log(log.join('\n'));
await browser.close();
