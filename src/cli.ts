#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { identityHeaders } from './identity.js';
import { closeBrowser, runPlainBrowser } from './launcher.js';
import { addProfile, getProfile, loadProfiles, removeProfile, updateProfile } from './profiles.js';
import { runProfile } from './supervisor.js';
import { finickyConfig, installUrlHandler, openLink } from './urlhandler.js';
import { validateBadge } from './docktile.js';
import { installService, isServiceInstalled, startService, stopService, uninstallService } from './service.js';

const usage = `agentic-playwright-mcp — many agents, one real browser, one tab group each.

Quick start:
  setup <profile> [--browser chrome|brave|chromium|edge|<path>]
                               create the profile, run it in the background (macOS),
                               and print the MCP entry for your client

Profiles (one persistent browser + gateway each):
  profile add <name> [--browser chrome|brave|chromium|edge|<path>] [--port N] [--cdp-port N] [--headless]
              [--badge <up to 3 chars>] [--badge-color <css color>]
  badge <profile> <label> [--badge-color <css color>]
                               label shown on the browser's Dock icon (macOS)
  profile list
  profile remove <name>

Running:
  start <profile>              run the browser (minimized) and the gateway in the foreground
                               (only while a matching app runs, if activate-with rules are set)
  activate-with <profile> <regex> [--exclude <regex>]
                               run the profile only while a process command line matches
  activate-with <profile> --always
  service install <profile>    run 'start' at login and keep it running (macOS launchd)
  service uninstall <profile>
  open <profile>               show the browser window
  login <profile>              open the browser without remote control to sign in to sites
                               that refuse automated browsers; quit it to resume the gateway

Client setup:
  config <profile>             print the MCP server entry for your client config
  identity                     headersHelper: print this agent's identity headers as JSON
  link-handler install         macOS: install the link handler (tab links, window activation)
  finicky-config [browser]     print a Finicky config that opens tab links without your browser
`;

// Log lines get a timestamp; the service log is the only record of what happened.
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => logError(new Date().toISOString(), ...args);

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'browser': { type: 'string' },
      'port': { type: 'string' },
      'cdp-port': { type: 'string' },
      'headless': { type: 'boolean' },
      'caps': { type: 'string' },
      'keep-tabs': { type: 'boolean' },
      'exclude': { type: 'string' },
      'always': { type: 'boolean' },
      'force': { type: 'boolean' },
      'badge': { type: 'string' },
      'badge-color': { type: 'string' },
      'help': { type: 'boolean', short: 'h' },
    },
  });
  const [command, sub, arg] = positionals;
  if (!command || values.help) {
    process.stdout.write(usage);
    return;
  }

  switch (command) {
    case 'profile': {
      if (sub === 'add' && arg) {
        const profile = addProfile(arg, {
          browser: values.browser,
          port: values.port ? Number(values.port) : undefined,
          cdpPort: values['cdp-port'] ? Number(values['cdp-port']) : undefined,
          headless: values.headless,
          badge: values.badge,
          badgeColor: values['badge-color'],
        });
        console.log(`Created profile "${profile.name}": gateway port ${profile.port}, browser ${profile.executablePath}`);
        console.log(`Next: agentic-playwright-mcp start ${profile.name}   (or: service install ${profile.name})`);
        return;
      }
      if (sub === 'list') {
        for (const p of loadProfiles())
          console.log(`${p.name}\thttp://127.0.0.1:${p.port}/mcp\tcdp ${p.cdpPort}\t${p.executablePath}`);
        return;
      }
      if (sub === 'remove' && arg) {
        removeProfile(arg);
        console.log(`Removed profile "${arg}" (browser data left in place).`);
        return;
      }
      break;
    }
    case 'start': {
      const profile = getProfile(requireArg(sub, 'profile'));
      await runProfile(profile, { caps: values.caps?.split(','), keepTabsOnExit: values['keep-tabs'] });
      return;
    }
    case 'activate-with': {
      // activate-with <profile> <regex> [--exclude <regex>] | activate-with <profile> --always
      const profile = getProfile(requireArg(sub, 'profile'));
      if (values.always) {
        updateProfile(profile.name, { activateWith: [] });
        console.log(`"${profile.name}" now runs all the time.`);
        return;
      }
      const rule = { match: requireArg(arg, 'regex'), ...(values.exclude ? { exclude: values.exclude } : {}) };
      new RegExp(rule.match);
      updateProfile(profile.name, { activateWith: [...(profile.activateWith ?? []), rule] });
      console.log(`"${profile.name}" runs while a process matches /${rule.match}/${rule.exclude ? ` and not /${rule.exclude}/` : ''}. Restart the service to apply.`);
      return;
    }
    case 'open': {
      const profile = getProfile(requireArg(sub, 'profile'));
      const res = await fetch(`http://127.0.0.1:${profile.port}/focus?home=1&go=1`).catch(() => undefined);
      if (!res?.ok)
        throw new Error(`Gateway for "${profile.name}" is not running.`);
      return;
    }
    case 'login': {
      const profile = getProfile(requireArg(sub, 'profile'));
      const service = isServiceInstalled(profile);
      if (service)
        stopService(profile);
      await closeBrowser(profile);
      console.log(`Opened "${profile.name}" as a normal browser. Sign in, then quit the browser (Cmd+Q) to hand it back to the agents.`);
      await runPlainBrowser(profile);
      if (service)
        startService(profile);
      console.log(service ? 'Gateway restarted.' : `Run: agentic-playwright-mcp start ${profile.name}`);
      return;
    }
    case 'service': {
      const profile = getProfile(requireArg(arg, 'profile'));
      if (sub === 'install')
        return installService(profile);
      if (sub === 'uninstall')
        return uninstallService(profile);
      break;
    }
    case 'config': {
      const profile = getProfile(requireArg(sub, 'profile'));
      printClientConfig(profile);
      return;
    }
    case 'setup': {
      // One-shot setup: profile, background service, link handler, client config.
      const name = requireArg(sub, 'profile');
      const profile = loadProfiles().find(p => p.name === name) ?? addProfile(name, {
        browser: values.browser,
        port: values.port ? Number(values.port) : undefined,
        cdpPort: values['cdp-port'] ? Number(values['cdp-port']) : undefined,
        headless: values.headless,
        badge: values.badge,
        badgeColor: values['badge-color'],
      });
      console.log(`Profile "${profile.name}": gateway http://127.0.0.1:${profile.port}/mcp, browser ${profile.executablePath}`);
      if (process.platform === 'darwin') {
        installService(profile);
        installUrlHandler();
      } else {
        console.log(`Run "agentic-playwright-mcp start ${profile.name}" under your own supervisor (systemd, pm2, ...).`);
      }
      console.log('');
      printClientConfig(profile);
      return;
    }
    case 'badge': {
      // badge <profile> <label> [--badge-color <css color>]
      const profile = getProfile(requireArg(sub, 'profile'));
      const label = requireArg(arg, 'label');
      validateBadge(label);
      updateProfile(profile.name, { badge: label, ...(values['badge-color'] ? { badgeColor: values['badge-color'] } : {}) });
      console.log(`Dock badge of "${profile.name}" set to "${label}". Restart the profile to apply (service install ${profile.name}).`);
      return;
    }
    case 'link-handler': {
      if (sub !== 'install')
        break;
      installUrlHandler({ force: values.force });
      return;
    }
    case 'finicky-config': {
      // finicky-config [<default browser>] > ~/.finicky.js
      process.stdout.write(finickyConfig(loadProfiles().map(p => p.port), sub ?? 'Safari'));
      return;
    }
    case 'open-link': {
      await openLink(requireArg(sub, 'url'));
      return;
    }
    case 'identity': {
      process.stdout.write(JSON.stringify(identityHeaders()));
      return;
    }
  }
  process.stdout.write(usage);
  process.exitCode = 1;
}

// Absolute paths, so GUI apps with a minimal PATH can run the headers helper.
function printClientConfig(profile: { name: string; port: number }) {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const entry = {
    type: 'http',
    url: `http://127.0.0.1:${profile.port}/mcp`,
    headersHelper: `${process.execPath} ${cli} identity`,
  };
  console.log('MCP server entry for your client config:');
  console.log(JSON.stringify({ mcpServers: { browser: entry } }, null, 2));
  console.log('');
  console.log('For Claude Code:');
  console.log(`  claude mcp add-json -s user browser '${JSON.stringify(entry)}'`);
}

function requireArg(value: string | undefined, name: string): string {
  if (!value)
    throw new Error(`Missing <${name}>. See --help.`);
  return value;
}

main().catch(e => {
  console.error((e as Error).message);
  process.exit(1);
});
