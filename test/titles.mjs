// Desktop chat titles come from the chat's own file,
// <app support>/Claude*/claude-code-sessions/<account>/<org>/<id>.json. The app
// also writes files with the same name in subfolders (waiting-input/<id>.json
// while the chat waits for the user, without a title); taking the newest of
// those renamed the chat's tab group to its folder name for as long as it waited.
//
// Usage: node test/titles.mjs
//
// Self-contained: fake chat files through AGENTIC_CLAUDE_APP_SUPPORT, no browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-titles-'));
process.env.AGENTIC_CLAUDE_APP_SUPPORT = home;
const { DesktopChatFile } = await import(new URL('../dist/titles.js', import.meta.url).href);
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok)
    failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const org = path.join(home, 'Claude-test', 'claude-code-sessions', 'account', 'org');
fs.mkdirSync(path.join(org, 'waiting-input'), { recursive: true });
const id = 'local_titles';
const chat = path.join(org, `${id}.json`);
fs.writeFileSync(chat, JSON.stringify({ sessionId: id, title: 'Real title', cliSessionId: 'sid' }));
const past = new Date(Date.now() - 60_000);
fs.utimesSync(chat, past, past);
fs.writeFileSync(path.join(org, 'waiting-input', `${id}.json`), '{}');

const read = new DesktopChatFile(id).read();
check('a newer waiting-input file does not replace the chat\'s title', read?.title === 'Real title', JSON.stringify(read));
check('... nor its CLI session id', read?.cliSessionId === 'sid');

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
