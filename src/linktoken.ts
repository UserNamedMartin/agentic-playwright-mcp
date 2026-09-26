// Tab links raise the browser window, so /focus only acts on signed links: a
// web page (in an agent's tab or anywhere) cannot make one, while the user
// can click one from anywhere. The secret lives in the profile's folder,
// readable by the user's own processes (the CLI's `open`, the link handler).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './profiles.js';

export function linkSecretFile(profile: string) {
  return path.join(homeDir, 'profiles', profile, 'link-secret');
}

export function readLinkSecret(profile: string, create = false): string | undefined {
  const file = linkSecretFile(profile);
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    if (!create)
      return undefined;
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

// `what` is "home" or "target:<targetId>".
export function linkToken(secret: string, what: string) {
  return crypto.createHmac('sha256', secret).update(what).digest('hex').slice(0, 32);
}
