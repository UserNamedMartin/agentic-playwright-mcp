// HTTP MCP gateway for one profile: one shared browser, many agent sessions.
//
// An agent session is keyed by the identity the client sends (see identity.ts),
// not by the MCP transport, so a reconnecting or resumed chat gets its tabs
// back. Sessions are cleaned up when the client process is gone, when the MCP
// session is deleted, or after a long idle period.
import http from 'node:http';
import type { Page } from 'playwright-core';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SharedBrowser } from './browser.js';
import { TabGroups } from './groups.js';
import { AgentSession, type SessionInfo } from './session.js';
import { pwTools, z, verifyInternals } from './internals.js';
import { extraTools } from './tools.js';
import { renderDashboard } from './dashboard.js';
import { openInBackgroundBinding, popupInterceptScript } from './popups.js';
import { TranscriptIndex } from './subagents.js';
import { cleanFolders, sessionFolder, subagentFolder } from './files.js';
import { appMimeType, openTabWindowTool, tabLinkHtml, tabLinkResource, tabLinkResourceUri, tabLinkTool } from './apps.js';

export type GatewayOptions = {
  profile: string;
  cdpEndpoint: string;
  port: number;
  host?: string;
  caps?: string[];
  idleTimeoutMs?: number;
  keepTabsOnExit?: boolean;
  // Root of the per-chat file folders (see files.ts).
  filesDir: string;
  // Chat folders unused this long are deleted.
  filesRetentionDays?: number;
};

type Transport = { transport: StreamableHTTPServerTransport; sessionKey: string };

export class Gateway {
  readonly options: GatewayOptions;
  readonly sessions = new Map<string, AgentSession>();
  shared!: SharedBrowser;
  groups: TabGroups | undefined;
  private _homeTargetId: string | undefined;
  private _stopping = false;
  private _transports = new Map<string, Transport>();
  private _transcripts = new Map<string, TranscriptIndex>();
  private _config: any;
  private _tools: any[] = [];
  private _server: http.Server | undefined;
  private _sweeper: NodeJS.Timeout | undefined;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  get baseUrl() {
    return `http://${this.options.host ?? '127.0.0.1'}:${this.options.port}`;
  }

  async start() {
    verifyInternals();
    this._config = await pwTools.resolveCLIConfigForMCP({
      cdpEndpoint: this.options.cdpEndpoint,
      caps: this.options.caps ?? ['devtools', 'network', 'storage', 'testing'],
    });
    this._tools = [...pwTools.filteredTools(this._config), ...extraTools(this)];
    this.shared = await SharedBrowser.connect(this.options.cdpEndpoint);
    this.shared.browser.on('disconnected', () => {
      if (this._stopping)
        return;
      console.error('Browser disconnected; exiting so the supervisor can restart the gateway.');
      process.exit(1);
    });
    const groups = new TabGroups(this.shared);
    this.groups = await groups.init() ? groups : undefined;
    await this.shared.context.exposeBinding(openInBackgroundBinding, async ({ page }: { page: Page }, url: string) => {
      const owner = [...this.sessions.values()].find(session => session.owned.has(page));
      await owner?.openInBackground(url);
    });
    await this.shared.context.addInitScript({ content: popupInterceptScript });
    this._server = http.createServer((req, res) => void this._handle(req, res).catch(e => {
      console.error(e);
      if (!res.headersSent)
        res.writeHead(500).end(String(e));
    }));
    await new Promise<void>(resolve => this._server!.listen(this.options.port, this.options.host ?? '127.0.0.1', resolve));
    await this._setUpHomeTab();
    this._sweeper = setInterval(() => void this._sweep(), 15_000);
    this._sweeper.unref();
    console.error(`[${this.options.profile}] gateway on ${this.baseUrl}/mcp, browser ${this.options.cdpEndpoint}, ` +
      `tab groups ${this.groups ? 'on' : 'off'}`);
  }

  async stop() {
    this._stopping = true;
    clearInterval(this._sweeper);
    for (const { transport } of this._transports.values())
      await transport.close().catch(() => {});
    for (const session of this.sessions.values())
      await this._closeSession(session);
    this._server?.close();
    await this.shared?.browser.close().catch(() => {});
  }

  // The status page is the one tab no agent owns: it keeps the window alive
  // when all agents have closed theirs, and shows who is working when the
  // user opens the window. The window is minimized on startup.
  private async _setUpHomeTab() {
    const pages = this.shared.context.pages();
    // With --no-startup-window there is no window yet.
    const home = pages.find(p => p.url().startsWith(this.baseUrl)) ?? pages[0] ?? await this.shared.newBackgroundPage(this.baseUrl, true);
    // Sessions do not survive a gateway restart, so tabs left from a previous
    // run (and windows Chrome restored) are orphans. One window keeps every
    // session's tabs, and so its tab group, together.
    for (const page of pages) {
      if (page !== home)
        await page.close().catch(() => {});
    }
    await this._adoptHome(home);
    await this.shared.startFocusGuard(this._homeTargetId!);
  }

  private async _adoptHome(home: Page) {
    if (!home.url().startsWith(this.baseUrl))
      await home.goto(this.baseUrl).catch(() => {});
    await this.groups?.pin(home).catch(() => {});
    this._homeTargetId = await this.shared.targetId(home);
    this.shared.setHomeTarget(this._homeTargetId);
    await this.shared.hideApp();
    // Closing the window (red button) closes every tab in it; put a fresh,
    // hidden window back so agents have somewhere to open tabs.
    home.once('close', () => {
      if (this._stopping)
        return;
      console.error('browser window was closed; creating a new hidden one');
      void this.shared.newBackgroundPage(this.baseUrl, true).then(page => this._adoptHome(page)).catch(e => console.error(e));
    });
  }

  toolSchemas() {
    return this._tools.map(tool => {
      const readOnly = tool.schema.type === 'readOnly' || tool.schema.type === 'assertion';
      const inputSchema = z.toJSONSchema(tool.schema.inputSchema);
      inputSchema.properties = {
        ...inputSchema.properties,
        tab: { type: 'string', description: 'Id of one of your tabs (from browser_tabs) to act on instead of the current tab.' },
        agent: { type: 'string', description: `Only if you called ${subagentTool.name}: the id it gave you.` },
      };
      return {
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema,
        annotations: { title: tool.schema.title, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
      };
    }).concat([subagentTool, tabLinkTool, openTabWindowTool] as any[]);
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.baseUrl);
    if (url.pathname === '/mcp')
      return await this._handleMcp(req, res);
    if (url.pathname === '/focus')
      return await this._handleFocus(url, res);
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(this));
      return;
    }
    res.writeHead(404).end('Not found');
  }

  private async _handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    if (mcpSessionId) {
      const entry = this._transports.get(mcpSessionId);
      if (!entry) {
        res.writeHead(404).end('Session not found');
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(400).end('Invalid request');
      return;
    }
    const body = await readJson(req);
    if (!isInitializeRequest(body)) {
      res.writeHead(400).end('Expected an initialize request');
      return;
    }
    const info = sessionInfoFromHeaders(req.headers, body.params?.clientInfo?.name);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: id => {
        this._transports.set(id, { transport, sessionKey: info.id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId)
        this._transports.delete(transport.sessionId);
    };
    const session = this._sessionFor(info);
    const server = this._createServer(session);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private _sessionFor(info: SessionInfo) {
    let session = this.sessions.get(info.id);
    if (session) {
      // Same agent reconnecting (MCP reconnect, resumed chat): keep its tabs.
      Object.assign(session.info, {
        pid: info.pid ?? session.info.pid,
        cwd: info.cwd ?? session.info.cwd,
        claudeSessionId: info.claudeSessionId ?? session.info.claudeSessionId,
        configDir: info.configDir ?? session.info.configDir,
      });
      if (info.title !== session.info.title) {
        session.info.title = info.title;
        void this.groups?.rename(session).catch(() => {});
      }
      return session;
    }
    console.error(`session opened: ${info.title} (${info.id}${info.pid ? `, pid ${info.pid}` : ''})`);
    session = new AgentSession(info, this.shared, this._config, this._tools,
        sessionFolder(this.options.filesDir, info.id, info.title), this.groups, this._retentionDays);
    this.sessions.set(info.id, session);
    return session;
  }

  private _createServer(session: AgentSession) {
    const server = new Server({ name: 'agentic-playwright-mcp', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.toolSchemas() }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      console.error(`resources/list from ${session.info.title}`);
      return { resources: [tabLinkResource] };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async request => {
      console.error(`resources/read ${request.params.uri} from ${session.info.title}`);
      if (request.params.uri !== tabLinkResourceUri)
        throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: tabLinkResourceUri, mimeType: appMimeType, text: tabLinkHtml }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { agent, ...args } = (request.params.arguments ?? {}) as Record<string, any>;
      if (request.params.name === subagentTool.name)
        return this._startSubagent(session, String(args.label ?? 'subagent'));
      const toolUseId = (request.params._meta as any)?.['claudecode/toolUseId'];
      const target = agent === undefined
        ? await this._autoTarget(session, toolUseId)
        : this.sessions.get(`${session.info.id}#${agent}`);
      if (!target)
        return errorResult(`Unknown agent "${agent}". Call ${subagentTool.name} first and pass the id it returns.`);
      if (request.params.name === tabLinkTool.name)
        return await this._tabLink(target, args.index);
      if (request.params.name === openTabWindowTool.name) {
        console.error(`tab link button clicked in ${session.info.title}`);
        return await this._openTabWindow(String(args.targetId ?? ''));
      }
      return await target.callTool(request.params.name, args, extra.signal);
    });
    return server;
  }

  // Claude Code subagents are recognized from the chat's transcripts, so they
  // get their own sub-session without passing anything.
  private async _autoTarget(session: AgentSession, toolUseId: unknown): Promise<AgentSession> {
    const { claudeSessionId, configDir } = session.info;
    if (typeof toolUseId !== 'string' || !claudeSessionId || !configDir)
      return session;
    let index = this._transcripts.get(session.info.id);
    if (!index) {
      index = new TranscriptIndex(configDir, claudeSessionId);
      this._transcripts.set(session.info.id, index);
    }
    const caller = await index.lookup(toolUseId).catch(() => undefined);
    if (caller?.kind !== 'subagent')
      return session;
    const id = `${session.info.id}#${caller.agentId}`;
    let sub = this.sessions.get(id);
    if (!sub) {
      const info: SessionInfo = { id, title: `${session.info.title} · ${caller.description}`.slice(0, 60), pid: session.info.pid, cwd: session.info.cwd };
      sub = new AgentSession(info, this.shared, this._config, this._tools,
          subagentFolder(session.filesDir, caller.agentId, caller.description), this.groups, this._retentionDays);
      this.sessions.set(id, sub);
      console.error(`subagent session opened: ${info.title}`);
    }
    return sub;
  }

  private async _tabLink(session: AgentSession, index: unknown) {
    const context = session.backend?._context;
    const tab = index === undefined ? context?.currentTab() : context?.tabs()[Number(index)];
    if (!tab)
      return errorResult('No such tab. Open a page first (browser_navigate), then call this again.');
    const targetId = await this.shared.targetId(tab.page);
    const url = tab.page.url();
    const title = await tab.page.title().catch(() => '');
    const link = `${this.baseUrl}/focus?target=${targetId}`;
    // Claude Code shows the model structuredContent instead of the text, so the
    // link and what to do with it are in both.
    const instruction = `Give the user this link as a markdown link, e.g. [Open "${title || url}" in the agent browser](${link}). ` +
      'Clicking it brings the agent browser window to the front on this tab.';
    return {
      content: [{ type: 'text' as const, text: instruction }],
      structuredContent: { link, instruction, targetId, url, title, profile: this.options.profile },
    };
  }

  private async _openTabWindow(targetId: string) {
    if (!targetId || !await this.shared.pageByTargetId(targetId))
      return errorResult('That tab is closed.');
    await this.shared.focusTab(targetId);
    return { content: [{ type: 'text' as const, text: 'Opened.' }] };
  }

  // A subagent gets its own sub-session: its own tabs, tab group and current
  // tab, so parallel subagents of one chat neither see nor wait for each other.
  // The gateway picks the id, so two subagents can never collide.
  private _startSubagent(parent: AgentSession, label: string) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'subagent';
    const handle = `${slug}-${++parent.subagentCount}`;
    const info: SessionInfo = {
      id: `${parent.info.id}#${handle}`,
      title: `${parent.info.title} · ${label}`.slice(0, 60),
      pid: parent.info.pid,
      cwd: parent.info.cwd,
    };
    const session = new AgentSession(info, this.shared, this._config, this._tools,
        subagentFolder(parent.filesDir, handle, label), this.groups, this._retentionDays);
    this.sessions.set(info.id, session);
    return { content: [{ type: 'text', text: `Your agent id is "${handle}". Pass "agent": "${handle}" in every browser call; ` +
      'your tabs live in their own tab group and other agents cannot see them.' }] };
  }

  // /focus?target=<id> is opened by a click on a link in a chat, i.e. in the
  // user's everyday browser, which comes to the front while it loads the page.
  // Activating our window right away loses that race, so the page itself asks
  // for the switch (…&go=1) once it is showing, then closes itself.
  // go=1 is also what the CLI and the agentic-browser:// handler call directly.
  private async _handleFocus(url: URL, res: http.ServerResponse) {
    const target = url.searchParams.get('home') ? this._homeTargetId : url.searchParams.get('target');
    if (!url.searchParams.get('go')) {
      const go = new URL(url);
      go.searchParams.set('go', '1');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Opening the agent browser…</title><p>Opening the agent browser…</p>` +
        `<script>setTimeout(async () => { await fetch(${JSON.stringify(go.pathname + go.search)}); window.close(); }, 200)</script>`);
      return;
    }
    try {
      if (!target)
        throw new Error('missing ?target=');
      await this.shared.focusTab(target);
      // Closes itself if someone opened the go=1 URL in a browser directly.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Opened</title><script>window.close()</script>');
    } catch (e) {
      res.writeHead(500).end(`Could not open the tab: ${(e as Error).message}`);
    }
  }

  private _isBound(session: AgentSession) {
    const rootId = session.info.id.split('#')[0];
    for (const { sessionKey } of this._transports.values()) {
      if (sessionKey === rootId)
        return true;
    }
    return false;
  }

  private get _retentionDays() {
    return this.options.filesRetentionDays ?? 7;
  }

  private _filesSweptAt = 0;

  private async _sweep() {
    const now = Date.now();
    if (now - this._filesSweptAt > 60 * 60 * 1000) {
      this._filesSweptAt = now;
      const inUse = new Set([...this.sessions.values()].map(s => s.filesDir));
      for (const name of cleanFolders(this.options.filesDir, this._retentionDays * 24 * 60 * 60 * 1000, inUse))
        console.error(`files: deleted ${name} (unused for ${this._retentionDays} days)`);
    }
    const idleTimeout = this.options.idleTimeoutMs ?? 24 * 60 * 60 * 1000;
    for (const session of [...this.sessions.values()]) {
      if (!this.sessions.has(session.info.id))
        continue;
      const processGone = session.info.pid !== undefined && !isAlive(session.info.pid);
      const idle = now - session.lastActivity > idleTimeout;
      const unboundWithoutPid = session.info.pid === undefined && !this._isBound(session) && now - session.lastActivity > 5 * 60 * 1000;
      if (processGone || idle || unboundWithoutPid)
        await this._closeSession(session);
    }
  }

  async _closeSession(session: AgentSession) {
    for (const child of [...this.sessions.values()]) {
      if (child.info.id.startsWith(`${session.info.id}#`))
        await this._closeSession(child);
    }
    console.error(`session closed: ${session.info.title} (${session.owned.size} tab(s))`);
    this.sessions.delete(session.info.id);
    this._transcripts.delete(session.info.id);
    for (const [id, entry] of this._transports) {
      if (entry.sessionKey === session.info.id) {
        this._transports.delete(id);
        await entry.transport.close().catch(() => {});
      }
    }
    await session.dispose({ closeTabs: !this.options.keepTabsOnExit });
    await this.groups?.forget(session);
  }
}

const subagentTool = {
  name: 'browser_subagent_start',
  description: 'Only for clients other than Claude Code (Claude Code subagents are recognized automatically). ' +
    'A subagent calls this once to get its own tab group, separate from the main chat and other subagents; it ' +
    'returns an agent id to pass as "agent" in every other browser call.',
  inputSchema: {
    type: 'object',
    properties: { label: { type: 'string', description: 'Short name of your task, shown in the tab group title, e.g. "pricing research".' } },
    required: ['label'],
  },
  annotations: { title: 'Start a subagent browser session', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text: `### Error\n${text}` }], isError: true };
}

export function sessionInfoFromHeaders(headers: http.IncomingHttpHeaders, clientName?: string): SessionInfo {
  const header = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' && value ? decodeURIComponent(value) : undefined;
  };
  const id = header('x-agent-session-id') ?? `anon-${crypto.randomUUID().slice(0, 8)}`;
  const pid = Number(header('x-agent-pid')) || undefined;
  return {
    id,
    pid,
    cwd: header('x-agent-cwd'),
    claudeSessionId: header('x-agent-claude-session'),
    configDir: header('x-agent-config-dir'),
    title: header('x-agent-title') ?? `${clientName ?? 'agent'} ${id.slice(-6)}`,
  };
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req)
    chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}
