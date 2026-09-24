// MCP Apps (SEP-1865) UI for tab links. browser_tab_link declares a ui://
// resource; hosts that render MCP Apps show it in the chat as a small card with
// an "Open" button, which calls browser_open_tab_window (app-only) through the
// host, so opening the tab never goes through the user's everyday browser.
// As of September 2026 the Claude desktop Code tab does not render MCP Apps from
// user-configured servers (it never reads the resource), so there the agent
// gives the http link from the result instead; see README "Tab links".

export const tabLinkResourceUri = 'ui://agentic-browser/tab-link.html';
export const appMimeType = 'text/html;profile=mcp-app';

export const tabLinkTool = {
  name: 'browser_tab_link',
  description: 'Get a link for the user that opens the shared browser window on one of your tabs (hosts that ' +
    'support MCP Apps also show it as a button). The browser runs minimized in the background; call this whenever ' +
    'the user may want to look at or act in a page (a login, a captcha, a result to review), give them the link and ' +
    'let them decide whether to click. Nothing opens until they do.',
  inputSchema: {
    type: 'object',
    properties: { index: { type: 'number', description: 'Tab index from browser_tabs. Defaults to the current tab.' } },
  },
  annotations: { title: 'Link to a tab', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { 'ui': { resourceUri: tabLinkResourceUri }, 'ui/resourceUri': tabLinkResourceUri },
};

export const openTabWindowTool = {
  name: 'browser_open_tab_window',
  description: 'Used by the tab link button: brings the browser window to the front on the given tab.',
  inputSchema: {
    type: 'object',
    properties: { targetId: { type: 'string' } },
    required: ['targetId'],
  },
  annotations: { title: 'Open a tab window', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['app'] } },
};

export const tabLinkResource = {
  uri: tabLinkResourceUri,
  name: 'Agent browser tab link',
  mimeType: appMimeType,
};

export const tabLinkHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>
  :root {
    --bg: var(--color-background-secondary, #f4f4f2);
    --fg: var(--color-text-primary, #1f1f1d);
    --muted: var(--color-text-secondary, #6b6b66);
    --border: var(--color-border-tertiary, #e2e1dc);
    --accent: var(--color-background-inverse, #1f1f1d);
    --accent-fg: var(--color-text-inverse, #ffffff);
    --radius: var(--border-radius-lg, 10px);
    --font: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: var(--color-background-secondary, #262624);
      --fg: var(--color-text-primary, #ecebe6);
      --muted: var(--color-text-secondary, #a09f99);
      --border: var(--color-border-tertiary, #3a3935);
      --accent: var(--color-background-inverse, #ecebe6);
      --accent-fg: var(--color-text-inverse, #1f1f1d);
    }
  }
  html, body { margin: 0; background: transparent; }
  body { font: 14px/1.4 var(--font); color: var(--fg); }
  .card { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--bg);
    border: 1px solid var(--border); border-radius: var(--radius); }
  .text { min-width: 0; flex: 1; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .url { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { flex: none; font: inherit; font-weight: 600; padding: 7px 14px; border: 0; border-radius: 8px;
    background: var(--accent); color: var(--accent-fg); cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .status { color: var(--muted); font-size: 12px; margin-top: 6px; }
</style>
</head>
<body>
<div class="card">
  <div class="text">
    <div class="title" id="title">Agent browser tab</div>
    <div class="url" id="url"></div>
  </div>
  <button id="open" disabled>Open</button>
</div>
<div class="status" id="status"></div>
<script>
  let nextId = 1;
  const pending = new Map();
  let targetId;
  const $ = id => document.getElementById(id);

  function send(message) { window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*'); }
  function request(method, params) {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function reportSize() {
    send({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(document.documentElement.getBoundingClientRect().height) } });
  }

  function showResult(result) {
    const data = result && result.structuredContent;
    if (!data || !data.targetId) {
      $('status').textContent = (result && result.content && result.content[0] && result.content[0].text) || 'No tab to open.';
      reportSize();
      return;
    }
    targetId = data.targetId;
    $('title').textContent = data.title || data.url || 'Agent browser tab';
    $('url').textContent = data.url || '';
    $('open').disabled = false;
    reportSize();
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0')
      return;
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result')
      showResult(message.params);
  });

  $('open').addEventListener('click', async () => {
    $('open').disabled = true;
    $('status').textContent = '';
    try {
      const result = await request('tools/call', { name: 'browser_open_tab_window', arguments: { targetId } });
      if (result && result.isError)
        throw new Error((result.content && result.content[0] && result.content[0].text) || 'failed');
    } catch (e) {
      $('status').textContent = 'Could not open the tab: ' + e.message;
    }
    $('open').disabled = false;
    reportSize();
  });

  new ResizeObserver(reportSize).observe(document.body);
  request('ui/initialize', {
    appInfo: { name: 'agentic-browser-tab-link', version: '0.1.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26',
  }).then(result => {
    const theme = result && result.hostContext && result.hostContext.theme;
    if (theme)
      document.documentElement.dataset.theme = theme;
    const vars = result && result.hostContext && result.hostContext.styles && result.hostContext.styles.variables;
    for (const [key, value] of Object.entries(vars || {}))
      document.documentElement.style.setProperty(key, value);
    send({ method: 'ui/notifications/initialized', params: {} });
    reportSize();
  }).catch(() => {});
</script>
</body>
</html>
`;
