// The launchd service the gateway runs as (macOS): what its plist asks for.
// Writes nothing into the user's LaunchAgents; it only builds the plist.
//
// Usage: node test/service.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-service-'));
process.env.AGENTIC_PLAYWRIGHT_HOME = home;
const { servicePlist } = await import('../dist/service.js');
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const plist = servicePlist({ name: 'test' });
const file = path.join(home, 'test.plist');
fs.writeFileSync(file, plist);
const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file]).toString());
check('the plist is valid', parsed.Label === 'dev.agentic-playwright-mcp.test', parsed.Label);
// Without a ProcessType launchd throttles the job below the user's own work:
// on a loaded machine the gateway starved and its sessions failed (2026-10-28).
check('the gateway is scheduled like the apps it serves', parsed.ProcessType === 'Interactive', parsed.ProcessType);
check('it runs "start <profile>"', parsed.ProgramArguments.slice(-2).join(' ') === 'start test', parsed.ProgramArguments.join(' '));

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
