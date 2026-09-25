// Status page served at the gateway root. It is also the browser's pinned home
// tab, so opening the window shows who is working in it.
import { escapeHtml, type Gateway } from './gateway.js';

export function renderDashboard(gateway: Gateway) {
  const sessions = [...gateway.sessions.values()].filter(session => session.started);
  const rows = sessions.map(session => {
    const tabs = [...session.owned].map(page => `<li>${escapeHtml(page.url())}</li>`).join('');
    const idle = Math.round((Date.now() - session.lastActivity) / 1000);
    return `<tr><td>${escapeHtml(session.info.title)}</td><td>${session.owned.size}<ul>${tabs}</ul></td><td>${idle}s ago</td></tr>`;
  }).join('');
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>${escapeHtml(gateway.options.profile)} · agentic-playwright-mcp</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #222; background: #fff; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
  ul { margin: 4px 0 0; padding-left: 18px; color: #666; font-size: 12px; }
  @media (prefers-color-scheme: dark) { body { background: #1b1b1b; color: #ddd; } td, th { border-color: #333; } }
</style>
<h1>${escapeHtml(gateway.options.profile)}</h1>
<p>${sessions.length} agent session(s) · tab groups ${gateway.groups ? 'on' : 'off'}</p>
<table><tr><th>Session</th><th>Tabs</th><th>Last activity</th></tr>${rows}</table>`;
}
