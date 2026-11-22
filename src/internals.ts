// Access to Playwright MCP internals. playwright-core is pinned to an exact
// version because we rely on non-public names; verifyInternals() fails loudly
// at startup if an upgrade renamed any of them.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const pwTools = require('playwright-core/lib/coreBundle').tools;
export const { z, ws, wsServer, yauzl, yazl } = require('playwright-core/lib/utilsBundle');
export const playwright = require('playwright-core');

// Methods of the MCP `Context` class that session.ts and scoped.ts use.
const contextMethods = [
  'ensureTab', 'ensureBrowserContext', '_onPageCreated', 'tabs', 'currentTab', 'routes', 'addRoute', 'dispose',
];

export function verifyInternals() {
  for (const name of ['BrowserBackend', 'filteredTools', 'browserTools']) {
    if (!pwTools[name])
      throw new Error(`playwright-core internals changed: tools.${name} is missing`);
  }
  if (typeof ws !== 'function' || typeof wsServer !== 'function')
    throw new Error('playwright-core internals changed: utilsBundle.ws / wsServer is missing');
  if (typeof z?.toJSONSchema !== 'function')
    throw new Error('playwright-core internals changed: zod toJSONSchema is missing');
}

export function verifyContext(context: any) {
  for (const name of contextMethods) {
    if (typeof context[name] !== 'function')
      throw new Error(`playwright-core internals changed: Context.${name} is missing`);
  }
  if (typeof context._onUnhandledRejection !== 'function')
    throw new Error('playwright-core internals changed: Context._onUnhandledRejection is missing');
  if (!Array.isArray(context._tabs))
    throw new Error('playwright-core internals changed: Context._tabs is missing');
}

// playwright-core is installed from patchright-core (see CLAUDE.md), whose
// evaluate calls run in an isolated world unless told otherwise. Agents'
// evaluate, run_code and init scripts expect the page's own world, as with
// stock Playwright (page globals, exposed bindings); running there needs no
// Runtime.enable. So every evaluate this connection sends goes to the main
// world, as upstream Playwright MCP was written for.
const evaluateMethods = new Set(['evaluateExpression', 'evaluateExpressionHandle', 'evalOnSelector', 'evalOnSelectorAll']);
export function evaluateInMainWorld(browser: any) {
  const connection = browser?._connection;
  if (typeof connection?.sendMessageToServer !== 'function')
    throw new Error('playwright-core internals changed: Connection.sendMessageToServer is missing');
  const send = connection.sendMessageToServer.bind(connection);
  connection.sendMessageToServer = (object: unknown, method: string, params: any, options: unknown) =>
    send(object, method, evaluateMethods.has(method) && params?.isolatedContext ? { ...params, isolatedContext: false } : params, options);
}

// patchright-core also changes how pages load, which Playwright MCP was not
// written for and agents do not need:
// - every page intercepts every request (CRPage turns request interception on
//   unconditionally): each request waits for this session's thread, and
//   Playwright aborts favicon requests while it intercepts;
// - init scripts and exposed bindings install a route on every request and
//   rewrite HTML documents (script tags, Content-Security-Policy) to inject
//   them. Page.addScriptToEvaluateOnNewDocument, which patchright uses as
//   well, needs no Runtime.enable, so the rewrite adds nothing.
// Both go back to upstream behavior: interception only while a route or
// interceptor asks for it, init scripts without rewriting documents.
export function keepNetworkUpstream(browser: any) {
  const toImpl = browser?._connection?.toImpl;
  const context = browser?.contexts?.()[0];
  if (typeof toImpl !== 'function' || !context)
    throw new Error('playwright-core internals changed: Connection.toImpl is missing');
  const noRoute = async () => {};
  const contextProto = Object.getPrototypeOf(context);
  if (typeof contextProto.installInjectRoute !== 'function')
    throw new Error('playwright-core internals changed: BrowserContext.installInjectRoute is missing');
  contextProto.installInjectRoute = noRoute;
  const fix = (page: any) => {
    const pageProto = Object.getPrototypeOf(page);
    if (typeof pageProto.installInjectRoute === 'function')
      pageProto.installInjectRoute = noRoute;
    const manager = toImpl(page)?.delegate?._networkManager;
    const proto = manager && Object.getPrototypeOf(manager);
    if (!proto || typeof proto.setRequestInterception !== 'function')
      throw new Error('playwright-core internals changed: CRNetworkManager.setRequestInterception is missing');
    if (!proto.__upstreamInterception) {
      const set = proto.setRequestInterception;
      proto.setRequestInterception = function(this: any, value: boolean) {
        return set.call(this, this._page ? this._page.needsRequestInterception() : value);
      };
      proto.__upstreamInterception = true;
    }
    void manager.setRequestInterception(false).catch(() => {});
  };
  for (const page of context.pages())
    fix(page);
  context.on('page', (page: any) => {
    try {
      fix(page);
    } catch (e) {
      console.error(String((e as Error).message));
    }
  });
}
