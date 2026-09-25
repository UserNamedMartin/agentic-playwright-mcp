// `agentic-playwright-mcp identity` is meant to be used as an MCP `headersHelper`.
// The client runs it as a (grand)child process, so it walks up the process tree
// to the agent process and reports who is connecting: a stable session id, the
// pid (so the gateway notices when the chat ends), its working directory and a
// human-readable title for the tab group.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopChat } from './titles.js';

type Proc = { pid: number; ppid: number; command: string; env: Record<string, string> };

const sessionEnvVars = ['CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID'];

export function identityHeaders(): Record<string, string> {
  const agent = findAgentProcess();
  const headers: Record<string, string> = {};
  if (!agent)
    return headers;
  const sessionId = sessionEnvVars.map(name => agent.env[name]).find(Boolean) ?? `pid-${agent.pid}`;
  const cwd = processCwd(agent.pid);
  const hostSessionId = agent.env['CLAUDE_CODE_HOST_SESSION_ID'];
  const desktop = desktopChat(hostSessionId);
  const title = desktop?.title ?? (cwd ? path.basename(cwd) : undefined) ?? `agent ${agent.pid}`;
  // Where Claude Code writes this chat's transcripts; the gateway reads them to
  // tell subagents apart (see subagents.ts).
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? agent.env['CLAUDE_CODE_SESSION_ID'] ?? desktop?.cliSessionId;
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? agent.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
  if (claudeSessionId && /(^|\/)claude( |$)/.test(agent.command)) {
    headers['x-agent-claude-session'] = encodeURIComponent(claudeSessionId);
    headers['x-agent-config-dir'] = encodeURIComponent(configDir);
  }
  headers['x-agent-session-id'] = encodeURIComponent(sessionId);
  headers['x-agent-pid'] = String(agent.pid);
  headers['x-agent-title'] = encodeURIComponent(title.slice(0, 60));
  // The chat may still be untitled or get renamed later; the gateway reads the
  // current title from the desktop app's chat file.
  if (hostSessionId)
    headers['x-agent-desktop-chat'] = encodeURIComponent(hostSessionId);
  if (cwd)
    headers['x-agent-cwd'] = encodeURIComponent(cwd);
  return headers;
}

function findAgentProcess(): Proc | undefined {
  let pid = process.ppid;
  let fallback: Proc | undefined;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const proc = readProcess(pid);
    if (!proc)
      break;
    if (sessionEnvVars.some(name => proc.env[name]))
      return proc;
    if (!fallback && /(^|\/)(claude|codex)( |$)/.test(proc.command))
      fallback = proc;
    pid = proc.ppid;
  }
  return fallback;
}

function readProcess(pid: number): Proc | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
          .filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      return { pid, ppid, command, env };
    }
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    // `ps eww` appends the environment to the command line; only our own processes are readable.
    const withEnv = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const env: Record<string, string> = {};
    for (const match of withEnv.slice(command.length).matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g))
      env[match[1]] = match[2];
    return { pid, ppid, command, env };
  } catch {
    return undefined;
  }
}

function processCwd(pid: number): string | undefined {
  try {
    if (process.platform === 'linux')
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    return out.split('\n').find(line => line.startsWith('n'))?.slice(1);
  } catch {
    return undefined;
  }
}
