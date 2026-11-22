// The page hook: the gateway's eyes in a page's own world, written so the
// page cannot tell it is there.
//
// What agents need from a page's own world, without DevTools listening to it
// (Runtime.enable, which sites detect):
// - console messages and uncaught errors, as rich as DevTools reports them;
// - permission and passkey requests, held until the agent answers.
//
// How it stays out of sight:
// - no globals: everything lives in one closure;
// - the functions it wraps (console methods, permission APIs, WebAuthn) are
//   Proxies of the originals, so name, length and prototype are the
//   originals'; Function.prototype.toString is wrapped the same way and
//   shows the original's source ("function log() { [native code] }") for
//   every wrapped function, itself included;
// - after it starts it calls only built-ins it saved at start, so a page that
//   replaces a built-in later never sees a call from it; objects it makes have
//   no prototype where a prototype would be consulted (Proxy handlers, event
//   init dictionaries), and it reads no property a page could have turned
//   into a getter;
// - it never looks inside a logged value: it keeps the values, and the
//   gateway reads them over DevTools (Runtime.getProperties), where V8
//   describes objects without running page code (no getters, no Proxy traps);
// - it talks to the gateway through two DOM events with secret names to and
//   from the gateway's isolated world, stopped before any page listener could
//   see them (in a worker, through a binding it takes off the global object
//   before the worker's own code runs).
//
// Error stacks: V8 calls a page's Error.prepareStackTrace when it formats a
// stack, which is how sites catch DevTools. So the hook reads a stack only
// while no page code is set to run there, and when a page has its own
// prepareStackTrace, the gateway is told not to look at errors (they are
// described from their name and message instead).

import { linkToken } from './linktoken.js';

export type HookNames = {
  // Events between the page's world and the gateway's isolated world.
  toGateway: string;
  fromGateway: string;
  // Asks an earlier copy of the hook in the same document whether it runs.
  ping: string;
  // The property of the hook's Proxy handlers that holds its state.
  holder: string;
  // The binding a worker's hook talks through.
  workerBinding: string;
  // A new copy of the isolated world's channel (after a gateway restart)
  // tells an older one to step aside.
  takeover: string;
};

export function hookNames(secret: string): HookNames {
  const name = (what: string) => 'x' + linkToken(secret, `page-hooks:${what}`).slice(0, 15);
  return { toGateway: name('to'), fromGateway: name('from'), ping: name('ping'), holder: name('holder'), workerBinding: name('worker'), takeover: name('takeover') };
}

// Built-ins saved before any page script runs, and small helpers that use
// only them.
const preamble = (names: HookNames) => `
  const N = ${JSON.stringify(names)};
  const G = globalThis;
  const R = Reflect, apply = R.apply, construct = R.construct, Px = Proxy, O = Object;
  const getDesc = O.getOwnPropertyDescriptor, defineProp = O.defineProperty, getProto = O.getPrototypeOf, create = O.create;
  const stringify = JSON.stringify, parse = JSON.parse;
  const TypeErrorC = G.TypeError, setProto = R.setPrototypeOf;
  const ErrorC = G.Error, isErrorFn = ErrorC.isError, FunctionProto = G.Function.prototype, ObjectProto = O.prototype;
  const nativeToString = FunctionProto.toString;
  const strIndexOf = G.String.prototype.indexOf, strSlice = G.String.prototype.slice, strCharCodeAt = G.String.prototype.charCodeAt;
  const StringC = G.String, symbolFor = G.Symbol.for, SymbolC = G.Symbol;
  const WM = G.WeakMap, wmGet = WM.prototype.get, wmSet = WM.prototype.set, wmHas = WM.prototype.has;
  const PromiseC = G.Promise, promThen = PromiseC.prototype.then, promReject = PromiseC.reject;
  const perf = G.performance, perfNow = perf && perf.now;
  // When something happened: the wall clock, as the browser's own console
  // entries are stamped (Date.now saved here, so a page's fake clock does
  // not count).
  const DateC = G.Date, dateNow = DateC.now;
  const at = () => apply(dateNow, DateC, []);
  const isWorker = typeof G.document === 'undefined';
  const doc = isWorker ? null : G.document;
  const ET = G.EventTarget && G.EventTarget.prototype;
  const addL = ET && ET.addEventListener, dispatch = ET && ET.dispatchEvent;
  const EventProto = G.Event && G.Event.prototype;
  const stopImm = EventProto && EventProto.stopImmediatePropagation, prevDef = EventProto && EventProto.preventDefault;
  const defaultPreventedGet = EventProto && getDesc(EventProto, 'defaultPrevented').get;
  const CE = G.CustomEvent, detailGet = CE && getDesc(CE.prototype, 'detail').get;
  const EEProto = G.ErrorEvent && G.ErrorEvent.prototype;
  const ee = name => EEProto && getDesc(EEProto, name).get;
  const eeError = ee('error'), eeMessage = ee('message'), eeFilename = ee('filename'), eeLineno = ee('lineno'), eeColno = ee('colno');
  const PREProto = G.PromiseRejectionEvent && G.PromiseRejectionEvent.prototype;
  const preReason = PREProto && getDesc(PREProto, 'reason').get;
  const keys = O.keys;
  // A copy of our own object literal without a prototype (index loop: a
  // page may have replaced the array iterator).
  const nullDict = props => { const o = create(null), k = keys(props); for (let i = 0; i < k.length; i++) o[k[i]] = props[k[i]]; return o; };
  const isError = v => { try { return isErrorFn ? apply(isErrorFn, ErrorC, [v]) : false; } catch { return false; } };
  // A data property's value along the prototype chain, never a getter's.
  const dataValue = (obj, key) => {
    for (let o = obj, i = 0; o && i < 20; o = getProto(o), i++) {
      const d = getDesc(o, key);
      if (d)
        return 'value' in d ? d.value : undefined;
    }
    return undefined;
  };
  const q = s => stringify(typeof s === 'string' ? s : '');
`;

// Whether formatting a stack can run page code, and the stack of a fresh
// error made here (or undefined when it could).
const stacks = `
  const pageHasStackHook = () => {
    const chain = [ErrorC, FunctionProto, ObjectProto];
    for (let i = 0; i < 3; i++) {
      if (getDesc(chain[i], 'prepareStackTrace'))
        return i > 0 || getDesc(ErrorC, 'prepareStackTrace').value !== undefined;
    }
    const limit = getDesc(ErrorC, 'stackTraceLimit');
    return !!limit && !('value' in limit);
  };
  // V8 puts the stack on each error as its own accessor (older versions: a
  // data property, or an accessor on Error.prototype). The error is a fresh
  // one made here, so its accessor is V8's.
  const stackOf = e => {
    const d = getDesc(e, 'stack') || getDesc(ErrorC.prototype, 'stack');
    if (!d)
      return undefined;
    return 'value' in d ? d.value : d.get ? apply(d.get, e, []) : undefined;
  };
  // The page's frame that called the wrapper: { url, line, col }, 0-based as
  // DevTools reports them; frames from this script (no URL) are skipped up
  // to it. Only built-in string functions saved above are used.
  const callSite = skip => {
    if (pageHasStackHook())
      return undefined;
    let text;
    try { text = stackOf(new ErrorC()); } catch { return undefined; }
    if (typeof text !== 'string')
      return undefined;
    let at = 0, frame = -1;
    for (;;) {
      const next = apply(strIndexOf, text, ['\\n    at ', at]);
      if (next < 0)
        return { url: '', line: 0, col: 0 };
      at = next + 8;
      frame++;
      if (frame < skip)
        continue;
      let end = apply(strIndexOf, text, ['\\n', at]);
      if (end < 0)
        end = text.length;
      let loc = apply(strSlice, text, [at, end]);
      const open = apply(strIndexOf, loc, [' (']);
      if (open >= 0 && apply(strCharCodeAt, loc, [loc.length - 1]) === 41)
        loc = apply(strSlice, loc, [open + 2, loc.length - 1]);
      // url:line:col (the url may hold colons itself)
      let c2 = -1, c1 = -1;
      for (let i = loc.length - 1; i >= 0; i--) {
        if (apply(strCharCodeAt, loc, [i]) === 58) {
          if (c2 < 0) c2 = i; else { c1 = i; break; }
        }
      }
      if (c1 < 0)
        return { url: '', line: 0, col: 0 };
      const url = apply(strSlice, loc, [0, c1]);
      if (apply(strIndexOf, url, ['<anonymous>']) >= 0 || apply(strIndexOf, url, ['eval at ']) >= 0)
        return { url: '', line: 0, col: 0 };
      return { url, line: +apply(strSlice, loc, [c1 + 1, c2]) - 1, col: +apply(strSlice, loc, [c2 + 1]) - 1 };
    }
  };
`;

// The hook's state, the masked wrapping, and the channel to the gateway.
const core = `
  const S = create(null);
  S.msgs = create(null);
  S.seq = 0;
  // One mask table for every realm of a page that can reach another (a
  // same-origin frame, a window it opened): one realm's toString must show
  // another realm's wrapped functions as the originals too. A new realm asks
  // its parent's (or opener's) toString for the table with a registered
  // symbol only the hook knows; it calls that toString only after seeing
  // it is a wrapped native, never a page's own function.
  const realmKey = apply(symbolFor, SymbolC, [N.holder]);
  const tableOf = w => {
    try {
      if (!w || w === G)
        return undefined;
      const F = getDesc(w, 'Function'), FP = F && 'value' in F && F.value && getDesc(F.value, 'prototype');
      const T = FP && 'value' in FP && FP.value && getDesc(FP.value, 'toString');
      const ts = T && 'value' in T ? T.value : undefined;
      if (typeof ts !== 'function' || apply(nativeToString, ts, []) !== 'function () { [native code] }')
        return undefined;
      const table = apply(ts, realmKey, []);
      return table && typeof table === 'object' ? table : undefined;
    } catch { return undefined; }
  };
  const masks = (!isWorker && (tableOf(G.parent) || tableOf(G.opener))) || new WM();
  const masked = v => apply(wmHas, masks, [v]);
  // A built-in that throws through a wrapper would show the wrapper's frame
  // in the error's stack: the line goes, before the page can read it. (When
  // the page formats stacks itself, nothing is read: that would run its
  // code.)
  // Frames "from".."from+count-1" of the error's stack (counted after the
  // message line) are the hook's own: they go before the page can read the
  // stack. Nothing is read while the page formats stacks itself (that would
  // run its code).
  const dropOurFrames = (e, from, count, rename) => {
    try {
      if (pageHasStackHook())
        return;
      const d = getDesc(e, 'stack');
      if (!d || !d.get || !d.set)
        return;
      const text = apply(d.get, e, []);
      if (typeof text !== 'string')
        return;
      const at = [];
      for (let i = apply(strIndexOf, text, ['\\n    at ']); i >= 0; i = apply(strIndexOf, text, ['\\n    at ', i + 1]))
        at[at.length] = i;
      if (at.length < from + count)
        return;
      const end = from + count < at.length ? at[from + count] : text.length;
      let head = apply(strSlice, text, [0, at[from]]);
      // The built-in's frame names the receiver's constructor, which V8
      // cannot see through a Proxy: as it reads without one.
      if (rename && at.length > 1 && apply(strSlice, text, [at[0], at[1]]) === rename[0])
        head = apply(strSlice, head, [0, at[0]]) + rename[1] + apply(strSlice, head, [at[1]]);
      apply(d.set, e, [head + apply(strSlice, text, [end])]);
    } catch {}
  };
  // A Proxy would let a prototype chain run through itself (V8 stops its
  // cycle check at a Proxy), where the original refuses: "Cyclic __proto__
  // value", as V8 says it.
  const cycleSafeSetPrototype = (proxy, target, proto) => {
    for (let p = proto, i = 0; p !== null && p !== undefined && i < 10000; i++) {
      if (p === proxy || p === target) {
        const e = construct(TypeErrorC, ['Cyclic __proto__ value']);
        // (this function and the trap; the built-in's frame stays)
        dropOurFrames(e, 0, 2);
        throw e;
      }
      p = masked(p) ? getProto(apply(wmGet, masks, [p])) : getProto(p);
    }
    return setProto(target, proto);
  };
  // An object made from a wrapped function (Object.create(console.log)):
  // V8 would name the original's constructor, Function.
  const behindWrapper = v => {
    try {
      if (v === null || typeof v !== 'object')
        return false;
      for (let p = getProto(v), i = 0; p && i < 100; p = getProto(p), i++) {
        if (masked(p))
          return true;
      }
    } catch {}
    return false;
  };
  const toStringHandler = create(null);
  toStringHandler[N.holder] = S;
  toStringHandler.setPrototypeOf = (target, proto) => cycleSafeSetPrototype(toStringProxy, target, proto);
  toStringHandler.apply = (target, self, args) => {
    if (self === realmKey) {
      // A newer copy of the worker hook (the gateway reconnected) hands over
      // its binding.
      if (typeof args[0] === 'function')
        workerBinding = args[0];
      return masks;
    }
    try {
      return apply(target, masked(self) ? apply(wmGet, masks, [self]) : self, args);
    } catch (e) {
      // (the built-in's frame stays, the trap's goes)
      dropOurFrames(e, 1, 1, behindWrapper(self) ? ['\\n    at Object.toString (<anonymous>)', '\\n    at Function.toString (<anonymous>)'] : undefined);
      throw e;
    }
  };
  const wrap = (obj, name, trap) => {
    if (!obj)
      return;
    const d = getDesc(obj, name);
    if (!d || typeof d.value !== 'function' || masked(d.value))
      return;
    const original = d.value;
    const handler = create(null);
    handler[N.holder] = S;
    // (The trap itself, so a stack has one frame of ours between the page's
    // call and the hook: see callSite.)
    handler.apply = trap;
    handler.setPrototypeOf = (target, proto) => cycleSafeSetPrototype(proxy, target, proto);
    const proxy = new Px(original, handler);
    apply(wmSet, masks, [proxy, original]);
    defineProp(obj, name, nullDict({ value: proxy, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable }));
  };
  const pending = create(null);
  const send = (detail) => {
    if (isWorker) {
      if (workerBinding)
        workerBinding(detail);
      return;
    }
    try {
      apply(dispatch, doc, [new CE(N.toGateway, nullDict({ detail, bubbles: false, cancelable: false, composed: false }))]);
    } catch {}
  };
  // Keeps a message's values for the gateway to read; the gateway's answer
  // (or 200 newer messages) lets them go.
  const keep = values => {
    const id = ++S.seq;
    S.msgs[id] = values;
    if (id > 200)
      delete S.msgs[id - 200];
    return id;
  };
  const ask = (kind, body) => new PromiseC(resolve => {
    const id = keep(undefined);
    pending[id] = resolve;
    send('{"id":' + id + ',"kind":' + q(kind) + ',"body":' + body + '}');
  });
  if (!isWorker) {
    apply(addL, doc, [N.fromGateway, function (event) {
      apply(stopImm, event, []);
      let reply;
      try { reply = parse(apply(detailGet, event, [])); } catch { return; }
      const id = reply && typeof reply.id === 'number' ? reply.id : 0;
      delete S.msgs[id];
      const resolve = pending[id];
      if (resolve) {
        delete pending[id];
        resolve(reply.value);
      }
    }, true]);
  }
`;

// Console methods and the message type DevTools reports for each.
const consoleTypes: Record<string, string> = {
  log: 'log', debug: 'debug', info: 'info', error: 'error', warn: 'warning', dir: 'dir', dirxml: 'dirxml',
  table: 'table', trace: 'trace', clear: 'clear', group: 'startGroup', groupCollapsed: 'startGroupCollapsed',
  groupEnd: 'endGroup', assert: 'assert', count: 'count', countReset: 'countReset', time: 'time', timeLog: 'log', timeEnd: 'timeEnd',
};

// Console messages and uncaught errors (page and worker).
const consoleHook = `
  const consoleTypes = ${JSON.stringify(consoleTypes)};
  const counts = create(null), timers = create(null);
  const label = args => args.length && args[0] !== undefined ? StringC(args[0]) : 'default';
  const elapsed = start => perfNow ? apply(perfNow, perf, []) - start : 0;
  // What DevTools would get as the message's arguments, as V8 builds them.
  const messageArgs = (method, args) => {
    const a = [];
    const rest = from => { for (let i = from; i < args.length; i++) a[a.length] = args[i]; };
    switch (method) {
      case 'assert':
        if (args[0])
          return undefined;
        if (args.length > 1) rest(1); else a[0] = 'console.assert';
        return { type: 'assert', args: a };
      case 'count': {
        const l = label(args);
        counts[l] = (counts[l] || 0) + 1;
        a[0] = l + ': ' + counts[l];
        return { type: 'count', args: a };
      }
      case 'countReset': {
        const l = label(args);
        if (l in counts) { counts[l] = 0; return undefined; }
        a[0] = "Count for '" + l + "' does not exist";
        return { type: 'warning', args: a };
      }
      case 'time': {
        const l = label(args);
        if (l in timers) { a[0] = "Timer '" + l + "' already exists"; return { type: 'warning', args: a }; }
        timers[l] = perfNow ? apply(perfNow, perf, []) : 0;
        return undefined;
      }
      case 'timeLog':
      case 'timeEnd': {
        const l = label(args);
        if (!(l in timers)) { a[0] = "Timer '" + l + "' does not exist"; return { type: 'warning', args: a }; }
        a[0] = l + ': ' + elapsed(timers[l]) + ' ms';
        if (method === 'timeEnd') delete timers[l]; else rest(1);
        return { type: consoleTypes[method], args: a };
      }
      case 'groupEnd':
      case 'clear':
        a[0] = 'console.' + method;
        return { type: consoleTypes[method], args: a };
      case 'group':
      case 'groupCollapsed':
        if (args.length) rest(0); else a[0] = 'console.' + method;
        return { type: consoleTypes[method], args: a };
      default:
        rest(0);
        return { type: consoleTypes[method], args: a };
    }
  };
  // Errors among the values: described from name and message by the hook
  // when V8 must not format their stacks (see pageHasStackHook).
  const errorTexts = values => {
    let out = '';
    for (let i = 0; i < values.length; i++) {
      if (!isError(values[i]))
        continue;
      const name = dataValue(values[i], 'name'), message = dataValue(values[i], 'message');
      const text = (typeof name === 'string' ? name : 'Error') + (typeof message === 'string' && message ? ': ' + message : '');
      values[i] = undefined;
      out += (out ? ',' : '') + q(StringC(i)) + ':' + q(text);
    }
    return '{' + out + '}';
  };
  const report = (method, args) => {
    const message = messageArgs(method, args);
    if (!message)
      return;
    const site = callSite(3);
    const unsafe = !site;
    const errors = unsafe ? errorTexts(message.args) : '{}';
    const id = keep(message.args);
    send('{"id":' + id + ',"kind":"console","body":{"t":' + at() + ',"type":' + q(message.type) + ',"url":' + q(site ? site.url : '') +
      ',"line":' + (site ? site.line : 0) + ',"col":' + (site ? site.col : 0) + ',"safe":' + !unsafe + ',"errors":' + errors + '}}');
  };
  const consoleObject = G.console;
  for (const method in consoleTypes) {
    wrap(consoleObject, method, (target, self, args) => {
      try { report(method, args); } catch {}
      return apply(target, self, args);
    });
  }
  // Uncaught errors and unhandled rejections: the thrown value, as DevTools
  // reports it.
  const reportError = (value, message, url, line, col) => {
    const unsafe = pageHasStackHook();
    const values = [value];
    const errors = unsafe ? errorTexts(values) : '{}';
    const id = keep(values);
    send('{"id":' + id + ',"kind":"pageerror","body":{"t":' + at() + ',"message":' + q(message) + ',"url":' + q(url) + ',"line":' + line +
      ',"col":' + col + ',"safe":' + !unsafe + ',"errors":' + errors + '}}');
  };
  // An error event without the thrown value is one a worker did not handle,
  // passed on to its page (the worker's own hook reports it, as DevTools
  // did), or one from a script of another origin.
  if (addL && EEProto) {
    apply(addL, G, ['error', function (event) {
      if (getProto(event) !== EEProto)
        return;
      try {
        const value = apply(eeError, event, []);
        if (value === null || value === undefined)
          return;
        const line = apply(eeLineno, event, []), col = apply(eeColno, event, []);
        reportError(value, StringC(apply(eeMessage, event, [])), StringC(apply(eeFilename, event, [])),
          typeof line === 'number' && line > 0 ? line - 1 : 0, typeof col === 'number' && col > 0 ? col - 1 : 0);
      } catch {}
    }, true]);
  }
  if (addL && PREProto && !isWorker) {
    apply(addL, G, ['unhandledrejection', function (event) {
      try { reportError(apply(preReason, event, []), '', '', 0, 0); } catch {}
    }, true]);
  }
`;

// Wraps the web APIs that ask for permissions. Each request is reported to the
// gateway first; "hold" requests wait for the agent's answer (see
// permissions.ts).
const permissionHook = `
  // kind: 'hold' (wait for the answer, API returns a promise), 'callback' (wait,
  // API returns nothing), 'report' (tell the gateway and go ahead).
  const askPermission = (permissions, api, hold) => {
    let list = '';
    for (let i = 0; i < permissions.length; i++) list += (i ? ',' : '') + q(permissions[i]);
    return ask('permission', '{"permissions":[' + list + '],"api":' + q(api) + ',"hold":' + !!hold + '}');
  };
  // Calls the original as the page did; an error it throws loses the trap's
  // frame (see dropOurFrames).
  const callThrough = (original, self, args) => {
    try {
      return apply(original, self, args);
    } catch (e) {
      // (this function and the trap)
      dropOurFrames(e, 0, 2);
      throw e;
    }
  };
  // A held call runs later: what the browser would refuse at once (wrong
  // receiver, missing or wrong arguments) is refused at once here too, with
  // the browser's words.
  const geolocationProto = G.Geolocation && G.Geolocation.prototype;
  const clearWatch = geolocationProto && geolocationProto.clearWatch;
  const checkGetCurrentPosition = (self, args) => {
    apply(clearWatch, self, [0]);
    const fail = text => { throw construct(TypeErrorC, ["Failed to execute 'getCurrentPosition' on 'Geolocation': " + text]); };
    if (args.length < 1)
      fail('1 argument required, but only ' + args.length + ' present.');
    if (typeof args[0] !== 'function')
      fail("parameter 1 is not of type 'Function'.");
    if (args.length > 1 && args[1] !== null && args[1] !== undefined && typeof args[1] !== 'function')
      fail("parameter 2 is not of type 'Function'.");
    if (args.length > 2 && args[2] !== null && args[2] !== undefined && typeof args[2] !== 'object' && typeof args[2] !== 'function')
      fail("The provided value is not of type 'PositionOptions'.");
  };
  const permissionWrap = (target, name, permissions, kind, check) => wrap(target, name, (original, self, args) => {
    if (check) {
      try {
        check(self, args);
      } catch (e) {
        // (the check and the trap)
        dropOurFrames(e, 0, 2);
        throw e;
      }
    }
    let names = [];
    try { names = typeof permissions === 'function' ? permissions(args[0]) : permissions; } catch {}
    if (!names.length)
      return callThrough(original, self, args);
    if (kind === 'report') {
      askPermission(names, name, false);
      return callThrough(original, self, args);
    }
    const answered = apply(promThen, askPermission(names, name, true), [() => apply(original, self, args)]);
    return kind === 'callback' ? undefined : answered;
  });
  const media = c => {
    const out = [];
    if (c && typeof c === 'object') {
      if (c.audio) out[out.length] = 'microphone';
      if (c.video) out[out.length] = 'camera';
    }
    return out;
  };
  permissionWrap(G.MediaDevices && G.MediaDevices.prototype, 'getUserMedia', media, 'hold');
  permissionWrap(G.Geolocation && G.Geolocation.prototype, 'getCurrentPosition', ['geolocation'], 'callback', clearWatch && checkGetCurrentPosition);
  permissionWrap(G.Geolocation && G.Geolocation.prototype, 'watchPosition', ['geolocation'], 'report');
  permissionWrap(G.Notification, 'requestPermission', ['notifications'], 'hold');
  permissionWrap(G.PushManager && G.PushManager.prototype, 'subscribe', ['notifications'], 'hold');
  permissionWrap(G.Navigator && G.Navigator.prototype, 'requestMIDIAccess', ['midi'], 'hold');
  permissionWrap(G.Clipboard && G.Clipboard.prototype, 'readText', ['clipboard-read'], 'report');
  permissionWrap(G.Clipboard && G.Clipboard.prototype, 'read', ['clipboard-read'], 'report');
  permissionWrap(G, 'queryLocalFonts', ['local-fonts'], 'report');
  permissionWrap(G.IdleDetector, 'requestPermission', ['idle-detection'], 'report');
  permissionWrap(G, 'getScreenDetails', ['window-management'], 'report');
  permissionWrap(G.Document && G.Document.prototype, 'requestStorageAccess', ['storage-access'], 'report');
`;

// Passkeys (see passkeys.ts): the gateway answers 'cancel' when nobody can see
// the browser, else 'proceed'. Passive requests (mediation "conditional")
// are left alone.
const passkeyHook = `
  const DOMExceptionC = G.DOMException;
  const credentials = G.CredentialsContainer && G.CredentialsContainer.prototype;
  for (const kind of ['get', 'create']) {
    wrap(credentials, kind, (original, self, args) => {
      const options = args[0];
      let passive = true;
      try { passive = !options || typeof options !== 'object' || !options.publicKey || options.mediation === 'conditional'; } catch {}
      if (passive)
        return apply(original, self, args);
      return apply(promThen, ask('passkey', '{"kind":' + q(kind) + '}'), [answer => answer === 'cancel'
        ? apply(promReject, PromiseC, [construct(DOMExceptionC, ['The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', 'NotAllowedError'])])
        : apply(original, self, args)]);
    });
  }
`;

// The page's world: console, errors, permissions, passkeys. Added to every
// document before its own scripts (Page.addScriptToEvaluateOnNewDocument);
// a second copy in the same document (after a gateway restart) stands down.
export function mainWorldHook(names: HookNames) {
  return `(() => {
  ${preamble(names)}
  if (isWorker || !CE || !dispatch)
    return;
  try {
    const ping = new CE(N.ping, nullDict({ cancelable: true, bubbles: false, composed: false, detail: null }));
    apply(dispatch, doc, [ping]);
    if (apply(defaultPreventedGet, ping, []))
      return;
  } catch { return; }
  apply(addL, doc, [N.ping, function (event) { apply(stopImm, event, []); apply(prevDef, event, []); }, true]);
  let workerBinding = undefined;
  ${stacks}
  ${core}
  const toStringProxy = new Px(nativeToString, toStringHandler);
  apply(wmSet, masks, [toStringProxy, nativeToString]);
  const tsDesc = getDesc(FunctionProto, 'toString');
  defineProp(FunctionProto, 'toString', nullDict({ value: toStringProxy, writable: tsDesc.writable, enumerable: tsDesc.enumerable, configurable: tsDesc.configurable }));
  ${consoleHook}
  ${permissionHook}
  ${passkeyHook}
})();`;
}

// A dedicated worker's world: console messages. Run by the gateway while the
// worker waits for the debugger, after it added the binding.
export function workerHook(names: HookNames) {
  return `(() => {
  ${preamble(names)}
  let workerBinding = typeof G[N.workerBinding] === 'function' ? G[N.workerBinding] : undefined;
  try { delete G[N.workerBinding]; } catch {}
  if (!workerBinding)
    return;
  // An earlier copy (from before a gateway restart) keeps running with the
  // new binding.
  // (Asked directly: "nativeToString" above is that copy's wrapper then.
  // The browser's own toString refuses the symbol with a TypeError.)
  try {
    const known = apply(getDesc(FunctionProto, 'toString').value, apply(symbolFor, SymbolC, [N.holder]), [workerBinding]);
    if (known && typeof known === 'object')
      return;
  } catch {}
  ${stacks}
  ${core}
  const toStringProxy = new Px(nativeToString, toStringHandler);
  apply(wmSet, masks, [toStringProxy, nativeToString]);
  const tsDesc = getDesc(FunctionProto, 'toString');
  defineProp(FunctionProto, 'toString', nullDict({ value: toStringProxy, writable: tsDesc.writable, enumerable: tsDesc.enumerable, configurable: tsDesc.configurable }));
  ${consoleHook}
})();`;
}

// The gateway's isolated world: passes the hook's messages to the gateway
// (through the bridge, see browser.ts) and its answers back.
export function isolatedChannel(names: HookNames) {
  return `(() => {
  if (window.__agenticChannel)
    return;
  window.__agenticChannel = true;
  const N = ${JSON.stringify(names)};
  // A copy in another isolated world (made by an earlier gateway
  // connection) would take the messages first and pass them to a binding
  // nobody listens to any more.
  document.dispatchEvent(new CustomEvent(N.takeover));
  const forward = event => {
    event.stopImmediatePropagation();
    let message;
    try { message = JSON.parse(event.detail); } catch { return; }
    if (!window.__agenticBridge || typeof message?.id !== 'number')
      return;
    window.__agenticBridge.call(message.kind, { id: message.id, ...message.body }).catch(() => null).then(value => {
      document.dispatchEvent(new CustomEvent(N.fromGateway, { detail: JSON.stringify({ id: message.id, value: value ?? null }) }));
    });
  };
  const stepAside = event => {
    event.stopImmediatePropagation();
    document.removeEventListener(N.toGateway, forward, true);
    document.removeEventListener(N.takeover, stepAside, true);
  };
  document.addEventListener(N.toGateway, forward, true);
  document.addEventListener(N.takeover, stepAside, true);
})();`;
}

// Playwright's console text for a message's arguments (renderPreview and the
// element handle preview in playwright-core), so the agent reads what it read
// when DevTools reported the message.
export function consoleText(args: any[]): string {
  return args.map(handlePreview).join(' ');
}

// JSHandle's preview: objects (they have an object id) by renderPreview,
// element handles start as "JSHandle@node", values by String(value), where
// only NaN, Infinity, -Infinity and -0 are parsed back (a BigInt reads
// "undefined", as it did).
function handlePreview(object: any): string {
  if (!object)
    return 'undefined';
  if (object.subtype === 'node')
    return 'JSHandle@node';
  if (object.objectId)
    return renderPreview(object) || `JSHandle@${object.subtype || object.type}`;
  const special: Record<string, number> = { 'NaN': NaN, 'Infinity': Infinity, '-Infinity': -Infinity, '-0': -0 };
  return String(object.unserializableValue ? special[object.unserializableValue] : object.value);
}

function renderPreview(object: any): string {
  if (!object || object.type === 'undefined')
    return 'undefined';
  if ('value' in object)
    return String(object.value);
  if (object.unserializableValue)
    return String(object.unserializableValue);
  if (object.description === 'Object' && object.preview) {
    const tokens = [];
    for (const { name, value } of object.preview.properties)
      tokens.push(`${name}: ${value}`);
    return `{${tokens.join(', ')}}`;
  }
  if (object.subtype === 'array' && object.preview)
    return sparseArrayToString(object.preview.properties);
  return object.description;
}

function sparseArrayToString(entries: { name: string; value: string }[]) {
  const arrayEntries = [];
  for (const { name, value } of entries) {
    const index = +name;
    if (isNaN(index) || index < 0)
      continue;
    arrayEntries.push({ index, value });
  }
  arrayEntries.sort((a, b) => a.index - b.index);
  let lastIndex = -1;
  const tokens = [];
  for (const { index, value } of arrayEntries) {
    const emptyItems = index - lastIndex - 1;
    if (emptyItems === 1)
      tokens.push('empty');
    else if (emptyItems > 1)
      tokens.push(`empty x ${emptyItems}`);
    tokens.push(String(value));
    lastIndex = index;
  }
  return '[' + tokens.join(', ') + ']';
}
