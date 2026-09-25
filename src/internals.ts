// Access to Playwright MCP internals. playwright-core is pinned to an exact
// version because we rely on non-public names; verifyInternals() fails loudly
// at startup if an upgrade renamed any of them.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const pwTools = require('playwright-core/lib/coreBundle').tools;
export const { z, ws } = require('playwright-core/lib/utilsBundle');
export const playwright = require('playwright-core');

// Methods of the MCP `Context` class that session.ts overrides or calls.
const contextMethods = [
  'newTab', 'selectTab', 'ensureTab', 'closeTab', 'dispose',
  'ensureBrowserContext', '_initializeBrowserContext', '_onPageCreated', '_onPageClosed',
];

export function verifyInternals() {
  for (const name of ['BrowserBackend', 'filteredTools', 'browserTools']) {
    if (!pwTools[name])
      throw new Error(`playwright-core internals changed: tools.${name} is missing`);
  }
  if (typeof ws !== 'function')
    throw new Error('playwright-core internals changed: utilsBundle.ws is missing');
  if (typeof z?.toJSONSchema !== 'function')
    throw new Error('playwright-core internals changed: zod toJSONSchema is missing');
}

export function verifyContext(context: any) {
  for (const name of contextMethods) {
    if (typeof context[name] !== 'function')
      throw new Error(`playwright-core internals changed: Context.${name} is missing`);
  }
  if (!Array.isArray(context._tabs))
    throw new Error('playwright-core internals changed: Context._tabs is missing');
}
