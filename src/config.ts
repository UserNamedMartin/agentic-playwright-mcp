// Playwright MCP config options that the stock Context applies when it sets up
// its browser context (initScript, allowed and blocked origins,
// testIdAttribute). Sessions replace that setup (see session.ts), and the
// options are the gateway's, not one agent's, so they are applied once to the
// shared context whenever the gateway connects to the browser.
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { playwright } from './internals.js';

// Same patterns as upstream's originOrHostGlob.
function originOrHostGlob(originOrHost: string) {
  const wildcardPort = originOrHost.match(/^(https?:\/\/[^/:]+):\*$/);
  if (wildcardPort)
    return `${wildcardPort[1]}:*/**`;
  try {
    const url = new URL(originOrHost);
    if (url.origin !== 'null')
      return `${url.origin}/**`;
  } catch {}
  return `*://${originOrHost}/**`;
}

export async function applyBrowserConfig(context: BrowserContext, config: any, gatewayUrl: string) {
  if (config.testIdAttribute)
    playwright.selectors.setTestIdAttribute(config.testIdAttribute);
  const configDir = config.configFile ? path.dirname(path.resolve(config.configFile)) : process.cwd();
  for (const script of config.browser?.initScript ?? [])
    await context.addInitScript({ path: path.resolve(configDir, script) });
  const allowed: string[] = config.network?.allowedOrigins ?? [];
  if (allowed.length) {
    // Routes registered later are matched first: block everything, then let
    // the allowed origins (and the gateway's own status page) through.
    await context.route('**', route => route.abort('blockedbyclient'));
    for (const origin of [...allowed, gatewayUrl])
      await context.route(originOrHostGlob(origin), route => route.continue());
  }
  for (const origin of config.network?.blockedOrigins ?? [])
    await context.route(originOrHostGlob(origin), route => route.abort('blockedbyclient'));
}
