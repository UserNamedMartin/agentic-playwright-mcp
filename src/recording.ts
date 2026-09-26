// The action recorder and tracing, shared by sessions. Playwright can run
// either only on a whole browser context, which here every chat shares, so
// each runs once for all the sessions that asked for it, and each session
// gets only what happened in its own tabs:
// - the recorder hands every recorded action to the session owning its page;
// - tracing is cut into chunks whenever a session starts or stops; a stopping
//   session gets its chunks with only its own calls, pages, console messages,
//   network requests, snapshots and screenshots.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { yauzl, yazl } from './internals.js';

// The session a Playwright call is made for (set around each tool call), so
// trace entries of calls can be told apart by session.
export const callingSession = new AsyncLocalStorage<any>();

// --- Recorder

type Recorder = { sessions: Map<any, string[]>; enabling: Promise<void> | undefined };
const recorders = new WeakMap<BrowserContext, Recorder>();

function recorderFor(raw: BrowserContext) {
  let recorder = recorders.get(raw);
  if (!recorder)
    recorders.set(raw, recorder = { sessions: new Map(), enabling: undefined });
  return recorder;
}

// `upstreamStart` is the stock Context.startRecording: it picks the codegen
// language and enables the recorder; only the place actions go is replaced.
export async function startRecording(session: any, context: any, upstreamStart: () => Promise<void>) {
  const raw: any = await context.ensureBrowserContext();
  const recorder = recorderFor(raw);
  if (recorder.sessions.has(session))
    throw new Error('Recording is already in progress.');
  recorder.sessions.set(session, []);
  const ownerOf = (page: Page) => [...recorder.sessions.keys()].find(s => s.owned.has(page) || s.owned.has(s.openers.get(page)));
  const sink = {
    actionAdded: (page: Page, _action: unknown, code: string) => ownerOf(page) && recorder.sessions.get(ownerOf(page))!.push(code),
    actionUpdated: (page: Page, _action: unknown, code: string) => {
      const list = ownerOf(page) && recorder.sessions.get(ownerOf(page));
      if (list)
        list.length ? list[list.length - 1] = code : list.push(code);
    },
    signalAdded: (page: Page, _signal: unknown, code: string) => {
      const list = ownerOf(page) && recorder.sessions.get(ownerOf(page));
      if (list?.length && code)
        list[list.length - 1] = code;
    },
  };
  recorder.enabling ??= (async () => {
    const enable = raw._enableRecorder.bind(raw);
    raw._enableRecorder = (params: any) => enable(params, sink);
    try {
      await upstreamStart();
    } finally {
      raw._enableRecorder = enable;
      context._recordedActions = undefined;
    }
  })();
  try {
    await recorder.enabling;
  } catch (e) {
    recorder.sessions.delete(session);
    recorder.enabling = undefined;
    throw e;
  }
}

export async function stopRecording(session: any, context: any): Promise<string[] | undefined> {
  const raw: any = context._rawBrowserContext ?? context;
  const recorder = raw && recorders.get(raw);
  const actions: string[] | undefined = recorder?.sessions.get(session);
  if (!recorder || !actions)
    return undefined;
  recorder.sessions.delete(session);
  if (!recorder.sessions.size) {
    recorder.enabling = undefined;
    await raw._disableRecorder().catch(() => {});
  }
  return actions.filter((code: string) => code.trim()).map(dedent);
}

function dedent(code: string) {
  const lines = code.split('\n');
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length));
  return lines.map(l => l.slice(indent)).join('\n');
}

// --- Tracing

type Tracer = {
  active: Map<any, { firstChunk: number; pages: Set<string>; stopWatching: () => void }>;
  chunks: (string | undefined)[];
  dir: string;
  callOwners: Map<number, any>;
  queue: Promise<unknown>;
  unhook: () => void;
};
const tracers = new WeakMap<BrowserContext, Tracer>();
// Sessions tracing, whatever browser context: told when a reconnect ends it.
const tracingSessions = new Set<any>();

export function isTracing(session: any) {
  return tracingSessions.has(session);
}

// Records which session made each Playwright call while tracing runs.
function hookCalls(raw: any, tracer: Tracer) {
  const connection = raw._connection;
  const original = connection.onmessage;
  connection.onmessage = (message: any) => {
    const session = callingSession.getStore();
    if (session && tracer.active.has(session))
      tracer.callOwners.set(message.id, session);
    return original.call(connection, message);
  };
  return () => { connection.onmessage = original; };
}

function serialized<T>(tracer: Tracer, op: () => Promise<T>): Promise<T> {
  const run = tracer.queue.then(op);
  tracer.queue = run.catch(() => {});
  return run;
}

async function cutChunk(raw: BrowserContext, tracer: Tracer, restart: boolean) {
  const file = path.join(tracer.dir, `chunk-${tracer.chunks.length}.zip`);
  await raw.tracing.stopChunk({ path: file });
  tracer.chunks.push(file);
  if (restart)
    await raw.tracing.startChunk();
}

export async function startTracing(session: any, context: any) {
  const raw: any = await context.ensureBrowserContext();
  let tracer = tracers.get(raw);
  if (!tracer) {
    tracer = { active: new Map(), chunks: [], dir: '', callOwners: new Map(), queue: Promise.resolve(), unhook: () => {} };
    tracers.set(raw, tracer);
  }
  const t = tracer;
  await serialized(t, async () => {
    if (t.active.has(session))
      throw new Error('Tracing has been already started');
    if (!t.active.size) {
      t.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-trace-'));
      t.chunks = [];
      t.unhook = hookCalls(raw, t);
      await raw.tracing.start({ screenshots: true, snapshots: true });
      await raw.tracing.startChunk();
    } else {
      await cutChunk(raw, t, true);
    }
    const pages = new Set<string>([...session.owned].map((page: any) => page._guid));
    const stopWatching = session.onAdopt((page: any) => pages.add(page._guid));
    t.active.set(session, { firstChunk: t.chunks.length, pages, stopWatching });
    tracingSessions.add(session);
  });
}

// Returns the session's trace as a zip, or undefined when `discard` (the
// session is ending).
export async function stopTracing(session: any, context: any, discard = false): Promise<Buffer | undefined> {
  const raw: any = context._rawBrowserContext ?? context;
  const tracer = raw && tracers.get(raw);
  if (!tracer || !tracer.active.has(session)) {
    tracingSessions.delete(session);
    if (discard)
      return undefined;
    throw new Error('Tracing is not started');
  }
  return await serialized(tracer, async () => {
    const entry = tracer.active.get(session)!;
    tracer.active.delete(session);
    tracingSessions.delete(session);
    entry.stopWatching();
    const last = !tracer.active.size;
    await cutChunk(raw, tracer, !last);
    if (last) {
      await raw.tracing.stop().catch(() => {});
      tracer.unhook();
    }
    for (const page of session.owned)
      entry.pages.add((page as any)._guid);
    const calls = new Set([...tracer.callOwners].filter(([, owner]) => owner === session).map(([id]) => `call@${id}`));
    const zip = discard ? undefined : await filterChunks(tracer.chunks.slice(entry.firstChunk).filter(Boolean) as string[], entry.pages, calls);
    for (const [id, owner] of tracer.callOwners) {
      if (owner === session)
        tracer.callOwners.delete(id);
    }
    // Chunks no session needs any more.
    const needed = Math.min(...[...tracer.active.values()].map(e => e.firstChunk), tracer.chunks.length);
    for (let i = 0; i < needed; i++) {
      if (tracer.chunks[i]) {
        fs.rmSync(tracer.chunks[i]!, { force: true });
        tracer.chunks[i] = undefined;
      }
    }
    if (last) {
      fs.rmSync(tracer.dir, { recursive: true, force: true });
      tracer.chunks = [];
    }
    return zip;
  });
}

// One trace (context header, then every kept entry of every chunk), the
// network log and the resources those entries reference. Each chunk's trace
// is parsed once; Playwright's network log grows from chunk to chunk, so it
// is taken from the last chunk only, from the session's own start on; only
// resources a kept entry refers to are read from the zips.
async function filterChunks(files: string[], pages: Set<string>, calls: Set<string>): Promise<Buffer> {
  const trace: string[] = [];
  let header: string | undefined;
  let sessionStart = -Infinity;
  for (const file of files) {
    const text = (await readZip(file, name => name === 'trace.trace')).get('trace.trace')?.toString('utf8') ?? '';
    const lines = text.split('\n').filter(Boolean);
    const events = lines.map(line => JSON.parse(line));
    for (const e of events) {
      if (e.type === 'frame-snapshot' && pages.has(e.snapshot?.pageId) && e.snapshot?.callId)
        calls.add(e.snapshot.callId);
    }
    for (const [i, e] of events.entries()) {
      let keep = false;
      switch (e.type) {
        case 'context-options':
          if (header === undefined) {
            header = lines[i];
            sessionStart = e.monotonicTime ?? -Infinity;
          }
          continue;
        case 'before': case 'after': case 'log': case 'input': keep = calls.has(e.callId); break;
        case 'frame-snapshot': keep = pages.has(e.snapshot?.pageId); break;
        case 'screencast-frame': case 'console': keep = pages.has(e.pageId); break;
        case 'event': keep = pages.has(e.params?.pageId); break;
        default: keep = false;
      }
      if (keep)
        trace.push(lines[i]);
    }
  }
  const network: string[] = [];
  const last = files[files.length - 1];
  if (last) {
    const text = (await readZip(last, name => name === 'trace.network')).get('trace.network')?.toString('utf8') ?? '';
    for (const line of text.split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (pages.has(e.snapshot?.pageref) && (e.snapshot?._monotonicTime ?? Infinity) >= sessionStart)
        network.push(line);
    }
  }
  const kept = trace.join('\n') + '\n' + network.join('\n');
  const wanted = (name: string) => (name.startsWith('resources/') || name.startsWith('screencast/')) && kept.includes(path.basename(name));
  const resources = new Map<string, Buffer>();
  for (const file of files) {
    for (const [name, data] of await readZip(file, name => wanted(name) && !resources.has(name)))
      resources.set(name, data);
  }
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from([header, ...trace].filter(Boolean).join('\n') + '\n'), 'trace.trace');
  zip.addBuffer(Buffer.from(network.join('\n') + (network.length ? '\n' : '')), 'trace.network');
  for (const [name, data] of resources)
    zip.addBuffer(data, name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream)
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// The entries of a zip that `want` asks for; the others are not read.
function readZip(file: string, want: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error: Error, zip: any) => {
      if (error)
        return reject(error);
      const entries = new Map<string, Buffer>();
      zip.on('entry', (entry: any) => {
        if (!want(entry.fileName))
          return zip.readEntry();
        zip.openReadStream(entry, (err: Error, stream: any) => {
          if (err)
            return reject(err);
          const parts: Buffer[] = [];
          stream.on('data', (d: Buffer) => parts.push(d));
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(parts)); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}
