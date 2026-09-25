// What browser_run_code_unsafe's `page` shows of the browser. Upstream the
// snippet gets the real page, and page.context() is the whole browser context,
// which here every chat shares: innocent code such as context.pages(),
// newPage(), clearCookies() or close() would reach other chats, steal focus or
// close everyone's browser. The snippet gets a view in which the browser holds
// only the session's own tabs, like the tools see it. This is about agents not
// having to know about each other, not a security boundary: the code runs in
// the gateway process and could reach anything on purpose.
import type { BrowserContext, Cookie, Page } from 'playwright-core';
import { applyStorageState, ownCookies, ownUrls, scopedStorageState } from './scoped.js';

// Members of BrowserContext that act on every page of it, with what to use
// instead. They throw in the view.
const refused: Record<string, string> = {
  addInitScript: 'page.addInitScript()',
  exposeBinding: 'page.exposeBinding()',
  exposeFunction: 'page.exposeFunction()',
  setExtraHTTPHeaders: 'page.setExtraHTTPHeaders()',
  setGeolocation: 'the browser_permission tool and page-level emulation',
  setHTTPCredentials: 'page-level authentication (for example a route that adds the header)',
  setDefaultTimeout: 'page.setDefaultTimeout()',
  setDefaultNavigationTimeout: 'page.setDefaultNavigationTimeout()',
  clearPermissions: 'the browser_permission tool',
  routeFromHAR: 'page.routeFromHAR()',
  routeWebSocket: 'page.routeWebSocket()',
  clock: 'no clock emulation (it would change every chat\'s pages)',
  tracing: 'the browser_start_tracing / browser_stop_tracing tools',
  debugger: 'no debugger access',
};

function refuse(name: string): never {
  throw new Error(`context.${name} is not available here: other chats share this browser and it would reach their ` +
    `tabs too. Use ${refused[name]} instead.`);
}

// Property values that would throw on any use (clock, tracing, debugger).
function refusedObject(name: string) {
  return new Proxy({}, { get: () => () => refuse(name) });
}

export function isolatedView(context: any) {
  const session = context._agentSession;
  const pages = new WeakMap<Page, Page>();
  let browserContextView: BrowserContext;

  const pageView = (page: Page): Page => {
    let view = pages.get(page);
    if (!view) {
      view = new Proxy(page, {
        get(target, key) {
          if (key === 'context')
            return () => browserContextView;
          if (key === 'clock')
            return refusedObject('clock');
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      pages.set(page, view);
    }
    return view;
  };

  const own = () => context.tabs().map((tab: any) => tab.page as Page);
  const ownedPage = async (page: Page) => session.owned.has(page) || session.owned.has(await page.opener().catch(() => null) as Page);
  const pageListeners = new Map<Function, Function>();

  const overrides: Record<string, any> = {
    pages: () => own().map(pageView),
    newPage: async () => pageView((await context.newTab()).page),
    browser: () => null,
    close: async () => {
      for (const page of own())
        await page.close().catch(() => {});
    },
    cookies: async (urls?: string | string[]) => urls?.length ? await raw().cookies(urls) : await ownCookies(context),
    clearCookies: async (options: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}) => {
      if (options.domain)
        return await raw().clearCookies(options);
      const matches = (value: string, filter?: string | RegExp) => filter === undefined || (typeof filter === 'string' ? value === filter : filter.test(value));
      for (const c of (await ownCookies(context)) as Cookie[]) {
        if (matches(c.name, options.name) && matches(c.path, options.path))
          await raw().clearCookies({ name: c.name, domain: c.domain, path: c.path });
      }
    },
    storageState: async (options: { path?: string } = {}) => {
      const state = await scopedStorageState(context);
      if (options.path)
        (await import('node:fs')).writeFileSync(options.path, JSON.stringify(state, null, 2));
      return state;
    },
    setStorageState: async (state: any) => await applyStorageState(context, typeof state === 'string'
      ? JSON.parse((await import('node:fs')).readFileSync(state, 'utf8'))
      : state),
    route: async (url: any, handler: any) => await context.addRoute({ pattern: url, handler }),
    unroute: async (url: any) => { await context.removeRoute(url); },
    unrouteAll: async () => { await context.removeRoute(); },
    setOffline: async (offline: boolean) => await session.setOffline(offline),
    grantPermissions: async (permissions: string[], options: { origin?: string } = {}) => {
      const origins = options.origin ? [options.origin] : [...new Set(ownUrls(context).map(u => new URL(u).origin))];
      for (const origin of origins)
        await raw().grantPermissions(permissions, { origin });
    },
    // Only pages of this session: its own new tabs and popups of its tabs.
    waitForEvent: async (event: string, optionsOrPredicate?: any) => {
      if (event !== 'page')
        return await raw().waitForEvent(event as any, optionsOrPredicate);
      const predicate = typeof optionsOrPredicate === 'function' ? optionsOrPredicate : optionsOrPredicate?.predicate;
      const timeout = optionsOrPredicate?.timeout ?? 30000;
      return await new Promise<Page>((resolve, reject) => {
        const timer = setTimeout(() => { raw().off('page', onPage); reject(new Error(`Timeout ${timeout}ms exceeded while waiting for event "page"`)); }, timeout);
        const onPage = async (page: Page) => {
          if (!await ownedPage(page) || (predicate && !await predicate(pageView(page))))
            return;
          clearTimeout(timer);
          raw().off('page', onPage);
          resolve(pageView(page));
        };
        raw().on('page', onPage);
      });
    },
    on: (event: string, listener: Function) => {
      if (event !== 'page')
        return raw().on(event as any, listener as any), browserContextView;
      const wrapped = async (page: Page) => { if (await ownedPage(page)) listener(pageView(page)); };
      pageListeners.set(listener, wrapped);
      raw().on('page', wrapped);
      return browserContextView;
    },
    off: (event: string, listener: Function) => {
      raw().off(event as any, (pageListeners.get(listener) ?? listener) as any);
      pageListeners.delete(listener);
      return browserContextView;
    },
  };
  overrides.once = (event: string, listener: Function) => {
    const once = (...args: any[]) => { overrides.off(event, once); listener(...args); };
    return overrides.on(event, once);
  };
  overrides.addListener = overrides.on;
  overrides.removeListener = overrides.off;

  let rawContext: BrowserContext;
  const raw = () => rawContext;
  const tabView = (tab: any) => new Proxy(tab, {
    get(target, key) {
      if (key === 'page')
        return pageView(target.page);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  // The tools get the stock Context; only the tab they run on is swapped.
  return new Proxy(context, {
    get(target, key) {
      if (key === 'ensureTab') {
        return async () => {
          rawContext = await target.ensureBrowserContext();
          browserContextView = new Proxy(rawContext, {
            get(real, name) {
              if (typeof name === 'string' && name in overrides)
                return overrides[name];
              if (typeof name === 'string' && name in refused)
                return ['clock', 'tracing', 'debugger'].includes(name) ? refusedObject(name) : () => refuse(name);
              const value = Reflect.get(real, name, real);
              return typeof value === 'function' ? value.bind(real) : value;
            },
          });
          return tabView(await target.ensureTab());
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
