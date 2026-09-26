// What browser_run_code_unsafe's `page` shows of the browser. Upstream the
// snippet gets the real page, and page.context() is the whole browser context,
// which here every chat shares. The snippet gets a membrane instead: every
// Playwright object it can reach (pages, frames, locators, handles, requests,
// responses, dialogs, console messages, downloads, workers, request contexts)
// is wrapped, and whatever leads to the browser context leads to a view in
// which the browser holds only the session's own tabs, as the tools see it.
// Events of other chats' pages are not delivered, context-wide calls are
// scoped or refused with the page-level alternative, and listeners the snippet
// leaves behind are removed when the session ends.
//
// This keeps agents from reaching each other by accident; it is not a
// security boundary: the code runs in the gateway process and could reach
// anything on purpose.
import fs from 'node:fs';
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

// Methods whose function argument runs in the page: it is passed as it is.
const serializingMethods = new Set(['evaluate', 'evaluateHandle', '$eval', '$$eval', 'evaluateAll', 'waitForFunction', 'addInitScript']);

// Context events and how to find the page each belongs to.
const pageOfEvent: Record<string, (arg: any) => Page | undefined> = {
  request: request => request.frame().page(),
  requestfinished: request => request.frame().page(),
  requestfailed: request => request.frame().page(),
  response: response => response.request().frame().page(),
  console: message => message.page() ?? undefined,
  dialog: dialog => dialog.page() ?? undefined,
  weberror: error => error.page() ?? undefined,
};
// Context events that never belong to one chat's tabs.
const silentEvents = new Set(['serviceworker', 'backgroundpage']);

// Removed when their session ends (see AgentSession.dispose).
const leftovers = new WeakMap<object, (() => void)[]>();

export function removeSnippetListeners(session: object) {
  for (const remove of leftovers.get(session)?.splice(0) ?? [])
    remove();
}

export function isolatedView(context: any) {
  const session = context._agentSession;
  const toTarget = new WeakMap<object, any>();
  const wrapped = new WeakMap<object, any>();
  let rawContext: BrowserContext;
  const cleanup = () => {
    let list = leftovers.get(session);
    if (!list)
      leftovers.set(session, list = []);
    return list;
  };

  const unwrap = (value: any): any => {
    if (value && typeof value === 'object' && toTarget.has(value))
      return toTarget.get(value);
    if (Array.isArray(value))
      return value.map(unwrap);
    return value;
  };

  // Functions the snippet hands to Playwright (listeners, predicates, route
  // handlers) get wrapped arguments, and their results are unwrapped.
  const callbacks = new WeakMap<Function, Function>();
  const wrapCallback = (fn: Function) => {
    let inner = callbacks.get(fn);
    if (!inner) {
      inner = (...args: any[]) => {
        const result = fn(...args.map(wrap));
        return result instanceof Promise ? result.then(unwrap) : unwrap(result);
      };
      callbacks.set(fn, inner);
    }
    return inner;
  };
  const unwrapArgs = (args: any[], serializes = false) => args.map(arg => typeof arg === 'function' && !serializes ? wrapCallback(arg) : unwrap(arg));

  const typeOf = (value: any): string | undefined => {
    if (!value || typeof value !== 'object')
      return undefined;
    // Client classes are bundled as "_Locator", "ConsoleMessage2", ...
    return value._type ?? value.constructor?.name?.replace(/^_/, '').replace(/\d+$/, '');
  };

  // Generic wrapper: methods take unwrapped arguments and return wrapped
  // results; a few members per type are replaced.
  function wrapObject(target: any, overrides: Record<string, any>) {
    const proxy = new Proxy(target, {
      get(real, key) {
        if (typeof key === 'string' && key in overrides)
          return overrides[key];
        const value = Reflect.get(real, key, real);
        if (typeof value !== 'function')
          return typeof key === 'string' && !key.startsWith('_') ? wrap(value) : value;
        return (...args: any[]) => wrap(value.apply(real, unwrapArgs(args, typeof key === 'string' && serializingMethods.has(key))));
      },
    });
    toTarget.set(proxy, target);
    wrapped.set(target, proxy);
    return proxy;
  }

  function wrap(value: any): any {
    if (value instanceof Promise)
      return value.then(wrap);
    if (Array.isArray(value))
      return value.map(wrap);
    if (!value || typeof value !== 'object')
      return value;
    if (wrapped.has(value))
      return wrapped.get(value);
    switch (typeOf(value)) {
      case 'BrowserContext': return contextView();
      case 'Browser': return null;
      case 'Page': return pageView(value);
      case 'APIRequestContext': return requestView(value);
      case 'Frame': case 'Locator': case 'FrameLocator': case 'ElementHandle': case 'JSHandle':
      case 'Request': case 'Response': case 'Route': case 'Dialog': case 'ConsoleMessage': case 'Download':
      case 'FileChooser': case 'Worker': case 'WebSocket': case 'WebError': case 'Keyboard': case 'Mouse':
      case 'Touchscreen': case 'Video': case 'Accessibility': case 'Coverage': case 'Screencast':
        return wrapObject(value, {});
      case 'Clock':
        return new Proxy({}, { get: () => () => refuse('clock') });
      default:
        return value;
    }
  }

  // Event subscriptions filtered to this session's pages.
  const subscribe = (emitter: any, event: string, listener: Function, filter: (arg: any) => Promise<boolean>, once = false) => {
    const handler = async (arg: any) => {
      let ok = false;
      try {
        ok = await filter(arg);
      } catch {}
      if (!ok)
        return;
      if (once)
        remove();
      listener(wrap(arg));
    };
    const remove = () => emitter.off(event, handler);
    emitter.on(event, handler);
    cleanup().push(remove);
    return { handler, remove };
  };

  const ownsEventArg = (event: string) => async (arg: any) => await session.ownsPage(pageOfEvent[event]?.(arg));

  const waitFor = (subscribeFn: (resolve: (value: any) => void) => () => void, event: string, options: any) => {
    const timeout = typeof options === 'object' && options?.timeout !== undefined ? options.timeout : 30000;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const unsubscribe = subscribeFn(value => {
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      });
      // 0 means no timeout, as in Playwright.
      if (timeout > 0) {
        timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout ${timeout}ms exceeded while waiting for event "${event}"`));
        }, timeout);
      }
    });
  };
  const predicateOf = (options: any) => typeof options === 'function' ? options : options?.predicate;

  function pageView(page: Page): Page {
    const popupSubscription = (listener: Function, once: boolean) => {
      let done = false;
      const off = session.onPopup((opener: Page, popup: Page) => {
        if (done || opener !== page)
          return;
        if (once)
          done = true;
        listener(pageView(popup));
      });
      cleanup().push(off);
      return off;
    };
    const popupListeners = new Map<Function, () => void>();
    return wrapObject(page, {
      context: () => contextView(),
      request: requestView(page.request),
      clock: new Proxy({}, { get: () => () => refuse('clock') }),
      opener: async () => {
        const opener = session.openers.get(page) ?? await page.opener();
        return opener && await session.ownsPage(opener) ? pageView(opener) : null;
      },
      // Tabs the page opens become background tabs without an opener (see
      // popups.ts); they still arrive as "popup" events here.
      on: (event: string, listener: Function) => {
        if (event === 'popup')
          popupListeners.set(listener, popupSubscription(listener, false));
        else
          page.on(event as any, wrapCallback(listener) as any);
        return pageView(page);
      },
      once: (event: string, listener: Function) => {
        if (event === 'popup')
          popupListeners.set(listener, popupSubscription(listener, true));
        else
          page.once(event as any, wrapCallback(listener) as any);
        return pageView(page);
      },
      off: (event: string, listener: Function) => {
        if (event === 'popup') {
          popupListeners.get(listener)?.();
          popupListeners.delete(listener);
        } else {
          page.off(event as any, wrapCallback(listener) as any);
        }
        return pageView(page);
      },
      waitForEvent: async (event: string, options?: any) => {
        if (event !== 'popup')
          return wrap(await page.waitForEvent(event as any, typeof options === 'function' ? wrapCallback(options) as any : options));
        const predicate = predicateOf(options);
        return await waitFor(resolve => session.onPopup(async (opener: Page, popup: Page) => {
          if (opener === page && (!predicate || await predicate(pageView(popup))))
            resolve(pageView(popup));
        }), 'popup', options);
      },
    });
  }

  function requestView(request: any) {
    if (wrapped.has(request))
      return wrapped.get(request);
    return wrapObject(request, {
      storageState: async (options: { path?: string } = {}) => {
        const state = await scopedStorageState(context);
        if (options.path)
          fs.writeFileSync(options.path, JSON.stringify(state, null, 2));
        return state;
      },
    });
  }

  let view: any;
  function contextView() {
    if (view)
      return view;
    const own = () => context.tabs().map((tab: any) => tab.page as Page);
    const listeners = new Map<string, Map<Function, () => void>>();
    const listen = (event: string, listener: Function, once: boolean) => {
      let remove: () => void;
      if (event === 'page') {
        const off = session.onAdopt((page: Page) => {
          if (once)
            off();
          listener(pageView(page));
        });
        cleanup().push(off);
        remove = off;
      } else if (silentEvents.has(event)) {
        remove = () => {};
      } else if (event in pageOfEvent) {
        remove = subscribe(rawContext, event, listener, ownsEventArg(event), once).remove;
      } else {
        const handler = wrapCallback(listener);
        (once ? rawContext.once : rawContext.on).call(rawContext, event as any, handler as any);
        remove = () => rawContext.off(event as any, handler as any);
        cleanup().push(remove);
      }
      if (!listeners.has(event))
        listeners.set(event, new Map());
      listeners.get(event)!.set(listener, remove);
      return view;
    };
    const overrides: Record<string, any> = {
      pages: () => own().map(pageView),
      newPage: async () => pageView(await session.openTab()),
      browser: () => null,
      request: requestView(rawContext.request),
      serviceWorkers: () => [],
      backgroundPages: () => [],
      close: async () => {
        for (const page of own())
          await page.close().catch(() => {});
      },
      newCDPSession: async (target: any) => {
        const page = unwrap(target);
        if (!await session.ownsPage(typeof page?.page === 'function' ? page.page() : page))
          throw new Error('newCDPSession: not one of your pages.');
        return await rawContext.newCDPSession(page);
      },
      cookies: async (urls?: string | string[]) => urls?.length ? await rawContext.cookies(urls) : await ownCookies(context),
      clearCookies: async (options: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}) => {
        if (options.domain)
          return await rawContext.clearCookies(options);
        const matches = (value: string, filter?: string | RegExp) => filter === undefined || (typeof filter === 'string' ? value === filter : filter.test(value));
        for (const c of (await ownCookies(context)) as Cookie[]) {
          if (matches(c.name, options.name) && matches(c.path, options.path))
            await rawContext.clearCookies({ name: c.name, domain: c.domain, path: c.path });
        }
      },
      storageState: async (options: { path?: string } = {}) => {
        const state = await scopedStorageState(context);
        if (options.path)
          fs.writeFileSync(options.path, JSON.stringify(state, null, 2));
        return state;
      },
      setStorageState: async (state: any) => { await applyStorageState(context, typeof state === 'string' ? JSON.parse(fs.readFileSync(state, 'utf8')) : state); },
      route: async (url: any, handler: Function) => await session.addRoute({ pattern: url, handler: wrapCallback(handler) }),
      unroute: async (url: any) => { await session.removeRoutes(url); },
      unrouteAll: async () => { await session.removeRoutes(); },
      setOffline: async (offline: boolean) => await session.setOffline(offline),
      grantPermissions: async (permissions: string[], options: { origin?: string } = {}) => {
        const origins = options.origin ? [options.origin] : [...new Set(ownUrls(context).map(u => new URL(u).origin))];
        for (const origin of origins)
          await rawContext.grantPermissions(permissions, { origin });
      },
      on: (event: string, listener: Function) => listen(event, listener, false),
      addListener: (event: string, listener: Function) => listen(event, listener, false),
      once: (event: string, listener: Function) => listen(event, listener, true),
      off: (event: string, listener: Function) => {
        listeners.get(event)?.get(listener)?.();
        listeners.get(event)?.delete(listener);
        return view;
      },
      removeListener: (event: string, listener: Function) => overrides.off(event, listener),
      removeAllListeners: (event?: string) => {
        for (const [name, map] of listeners) {
          if (event && name !== event)
            continue;
          map.forEach(remove => remove());
          map.clear();
        }
        return view;
      },
      waitForEvent: async (event: string, options?: any) => {
        const predicate = predicateOf(options);
        return await waitFor(resolve => {
          const handler = async (value: any) => {
            if (!predicate || await predicate(value))
              resolve(value);
          };
          listen(event, handler, false);
          return () => overrides.off(event, handler);
        }, event, options);
      },
    };
    for (const name of Object.keys(refused)) {
      overrides[name] = ['clock', 'tracing', 'debugger'].includes(name)
        ? new Proxy({}, { get: () => () => refuse(name) })
        : () => refuse(name);
    }
    view = wrapObject(rawContext, overrides);
    return view;
  }

  // The tools get the stock Context; only the tab they run on is swapped.
  return new Proxy(context, {
    get(target, key) {
      if (key === 'ensureTab') {
        return async () => {
          rawContext = await target.ensureBrowserContext();
          const tab = await target.ensureTab();
          return new Proxy(tab, {
            get(real, name) {
              if (name === 'page')
                return pageView(real.page);
              const value = Reflect.get(real, name, real);
              return typeof value === 'function' ? value.bind(real) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
