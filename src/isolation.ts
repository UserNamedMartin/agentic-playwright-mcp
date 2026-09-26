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
  credentials: 'no virtual passkeys (they would replace every chat\'s passkey prompts)',
};
// Refused members that are objects rather than methods.
const refusedObjects = new Set(['clock', 'tracing', 'debugger', 'credentials']);

// DevTools commands of a CDP session on one of the session's pages that reach
// the whole browser (other tabs, every site's cookies and storage).
const browserWideCommands = /^(Target|Browser|Storage|SystemInfo|Extensions|Tethering|Tracing)\.|^Network\.(getAllCookies|clearBrowserCookies|clearBrowserCache)$|^Security\.setIgnoreCertificateErrors$/;

function refuse(name: string): never {
  throw new Error(`context.${name} is not available here: other chats share this browser and it would reach their ` +
    `tabs too. Use ${refused[name]} instead.`);
}

// Methods whose function argument runs in the page: it is passed as it is.
const serializingMethods = new Set(['evaluate', 'evaluateHandle', '$eval', '$$eval', 'evaluateAll', 'waitForFunction', 'addInitScript']);

// Context events and how to find the page each belongs to. Only these are
// delivered (to the owner of that page); any other context event is not:
// "page" and "close" are handled separately, and events added by a later
// Playwright stay silent until they are listed here.
const pageOfEvent: Record<string, (arg: any) => Page | undefined> = {
  request: request => request.frame().page(),
  requestfinished: request => request.frame().page(),
  requestfailed: request => request.frame().page(),
  response: response => response.request().frame().page(),
  console: message => message.page() ?? undefined,
  dialog: dialog => dialog.page() ?? undefined,
  dialogclosed: dialog => dialog.page?.() ?? undefined,
  weberror: error => error.page() ?? undefined,
  framenavigated: frame => frame.page(),
  frameattached: frame => frame.page(),
  framedetached: frame => frame.page(),
  pageload: page => page,
  pageclose: page => page,
  download: download => download.page(),
};

// Listeners a snippet leaves behind, removed when its session ends (see
// AgentSession.dispose); each leaves the set once removed.
const leftovers = new WeakMap<object, Set<() => void>>();

export function removeSnippetListeners(session: object) {
  for (const remove of [...leftovers.get(session) ?? []])
    remove();
}

const emitterMethods = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener', 'off', 'removeListener', 'removeAllListeners', 'listeners', 'rawListeners', 'listenerCount'];

export function isolatedView(context: any) {
  const session = context._agentSession;
  const toTarget = new WeakMap<object, any>();
  const wrapped = new WeakMap<object, any>();
  let rawContext: BrowserContext;
  const track = (remove: () => void) => {
    let set = leftovers.get(session);
    if (!set)
      leftovers.set(session, set = new Set());
    const tracked = () => {
      set!.delete(tracked);
      remove();
    };
    set.add(tracked);
    return tracked;
  };

  // EventEmitter methods of a view, over `listen(event, listener, once)`
  // returning a remover; `self` is what chaining methods return.
  const emitter = (listen: (event: string, listener: Function, once: boolean) => () => void, self: () => any) => {
    const listeners = new Map<string, Map<Function, () => void>>();
    const add = (event: string, listener: Function, once: boolean) => {
      if (!listeners.has(event))
        listeners.set(event, new Map());
      listeners.get(event)!.get(listener)?.();
      listeners.get(event)!.set(listener, listen(event, listener, once));
      return self();
    };
    const off = (event: string, listener: Function) => {
      listeners.get(event)?.get(listener)?.();
      listeners.get(event)?.delete(listener);
      return self();
    };
    return {
      on: (event: string, listener: Function) => add(event, listener, false),
      addListener: (event: string, listener: Function) => add(event, listener, false),
      prependListener: (event: string, listener: Function) => add(event, listener, false),
      once: (event: string, listener: Function) => add(event, listener, true),
      prependOnceListener: (event: string, listener: Function) => add(event, listener, true),
      off,
      removeListener: off,
      removeAllListeners: (event?: string) => {
        for (const [name, map] of listeners) {
          if (event && name !== event)
            continue;
          map.forEach(remove => remove());
          map.clear();
        }
        return self();
      },
      listeners: (event: string) => [...listeners.get(event)?.keys() ?? []],
      rawListeners: (event: string) => [...listeners.get(event)?.keys() ?? []],
      listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    };
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
  const isPlain = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value));
  // Plain objects handed to a callback (exposeBinding's source: its page,
  // frame and context) are wrapped member by member.
  const wrapArg = (value: any) => isPlain(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)])) : wrap(value);
  const wrapCallback = (fn: Function) => {
    let inner = callbacks.get(fn);
    if (!inner) {
      inner = (...args: any[]) => {
        const result = fn(...args.map(wrapArg));
        return result instanceof Promise ? result.then(unwrap) : unwrap(result);
      };
      callbacks.set(fn, inner);
    }
    return inner;
  };
  // Functions in option objects ({ predicate }) are callbacks too.
  const unwrapArg = (arg: any, serializes: boolean): any => {
    if (typeof arg === 'function')
      return serializes ? arg : wrapCallback(arg);
    if (isPlain(arg))
      return Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, typeof v === 'function' && !serializes ? wrapCallback(v) : unwrap(v)]));
    return unwrap(arg);
  };
  const unwrapArgs = (args: any[], serializes = false) => args.map(arg => unwrapArg(arg, serializes));

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
      // A page of another chat is never handed out.
      case 'Page': return session.owned.has(value) || session.owned.has(session.openers.get(value)) ? pageView(value) : null;
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

  // A context event subscription delivering only this session's pages' events.
  const subscribe = (emitterObject: any, event: string, listener: Function, once: boolean) => {
    const handler = async (arg: any) => {
      let ok = false;
      try {
        ok = await session.ownsPage(pageOfEvent[event](arg));
      } catch {}
      if (!ok)
        return;
      if (once)
        remove();
      listener(wrap(arg));
    };
    const remove = track(() => emitterObject.off(event, handler));
    emitterObject.on(event, handler);
    return remove;
  };

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
    if (wrapped.has(page))
      return wrapped.get(page);
    // Tabs the page opens become background tabs without an opener (see
    // popups.ts); they still arrive as "popup" events here. Other events of
    // the page are its own.
    const listen = (event: string, listener: Function, once: boolean) => {
      if (event === 'popup') {
        let done = false;
        let off: () => void;
        const unsubscribe = session.onPopup((opener: Page, popup: Page) => {
          if (done || opener !== page)
            return;
          if (once) {
            done = true;
            off();
          }
          listener(pageView(popup));
        });
        off = track(unsubscribe);
        return off;
      }
      const handler = wrapCallback(listener);
      (once ? page.once : page.on).call(page, event as any, handler as any);
      return track(() => page.off(event as any, handler as any));
    };
    const events = emitter(listen, () => pageView(page));
    return wrapObject(page, {
      ...events,
      context: () => contextView(),
      request: requestView(page.request),
      clock: new Proxy({}, { get: () => () => refuse('clock') }),
      opener: async () => {
        const opener = session.openers.get(page) ?? await page.opener();
        return opener && await session.ownsPage(opener) ? pageView(opener) : null;
      },
      waitForEvent: async (event: string, options?: any) => {
        const predicate = predicateOf(options);
        return await waitFor(resolve => listen(event, async (value: any) => {
          if (!predicate || await predicate(value))
            resolve(value);
        }, false), event, options);
      },
    });
  }

  function requestView(request: any) {
    if (wrapped.has(request))
      return wrapped.get(request);
    return wrapObject(request, {
      // One request context serves every chat: disposing it would break
      // page.request for all of them.
      dispose: async () => {},
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
    const listen = (event: string, listener: Function, once: boolean): (() => void) => {
      if (event === 'page') {
        let off: () => void;
        const unsubscribe = session.onAdopt((page: Page) => {
          if (once)
            off();
          listener(pageView(page));
        });
        off = track(unsubscribe);
        return off;
      }
      if (event in pageOfEvent)
        return subscribe(rawContext, event, listener, once);
      if (event === 'close') {
        const handler = () => listener(view);
        (once ? rawContext.once : rawContext.on).call(rawContext, 'close' as any, handler as any);
        return track(() => rawContext.off('close' as any, handler as any));
      }
      return () => {};
    };
    const events = emitter(listen, () => view);
    const overrides: Record<string, any> = {
      ...events,
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
        const cdp = await rawContext.newCDPSession(page);
        return new Proxy(cdp, {
          get(real, key) {
            if (key === 'send') {
              return async (method: string, params?: any) => {
                if (browserWideCommands.test(method))
                  throw new Error(`${method} is not available here: it reaches the whole browser, which other chats share.`);
                return await real.send(method as any, params);
              };
            }
            const value = Reflect.get(real, key, real);
            return typeof value === 'function' ? value.bind(real) : value;
          },
        });
      },
      cookies: async (urls?: string | string[]) => urls?.length ? await rawContext.cookies(urls) : await ownCookies(context),
      // A domain named as a string is the agent's explicit choice; a pattern
      // (like /./) only reaches the sites of its own tabs.
      clearCookies: async (options: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}) => {
        if (typeof options.domain === 'string')
          return await rawContext.clearCookies(options);
        const matches = (value: string, filter?: string | RegExp) => filter === undefined || (typeof filter === 'string' ? value === filter : filter.test(value));
        for (const c of (await ownCookies(context)) as Cookie[]) {
          if (matches(c.name, options.name) && matches(c.path, options.path) && matches(c.domain, options.domain))
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
      // Routes from code cannot be saved across a gateway restart.
      route: async (url: any, handler: Function) => await session.addRoute({ pattern: url, handler: wrapCallback(handler), fromCode: true }),
      unroute: async (url: any) => { await session.removeRoutes(url); },
      unrouteAll: async () => { await session.removeRoutes(); },
      setOffline: async (offline: boolean) => await session.setOffline(offline),
      grantPermissions: async (permissions: string[], options: { origin?: string } = {}) => {
        const origins = options.origin ? [options.origin] : [...new Set(ownUrls(context).map(u => new URL(u).origin))];
        for (const origin of origins)
          await rawContext.grantPermissions(permissions, { origin });
      },
      waitForEvent: async (event: string, options?: any) => {
        const predicate = predicateOf(options);
        return await waitFor(resolve => listen(event, async (value: any) => {
          if (!predicate || await predicate(value))
            resolve(value);
        }, false), event, options);
      },
    };
    for (const name of Object.keys(refused)) {
      overrides[name] = refusedObjects.has(name)
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
