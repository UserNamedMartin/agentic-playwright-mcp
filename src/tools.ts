// Tools added on top of the stock Playwright MCP set. Same shape as Playwright's
// own tool definitions: { capability, schema, handle(context, params, response) }.
import type { CDPSession, Page } from 'playwright-core';
import type { Gateway } from './gateway.js';
import { playwright, z } from './internals.js';
import { permissionTypes } from './permissions.js';

// Emulation overrides only last while the CDP session that set them stays
// attached, so keep one per page.
const emulationSessions = new WeakMap<Page, CDPSession>();

export type Emulation = { width: number; height: number; mobile: boolean; deviceScaleFactor: number; touch: boolean; userAgent?: string };

// Applies (or with undefined, clears) a tab's device emulation.
export async function applyEmulation(page: Page, settings: Emulation | undefined) {
  let cdp = emulationSessions.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    emulationSessions.set(page, cdp);
  }
  if (!settings) {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });
    return;
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: settings.width, height: settings.height, mobile: settings.mobile, deviceScaleFactor: settings.deviceScaleFactor,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: settings.touch, maxTouchPoints: settings.touch ? 5 : 1 });
  if (settings.userAgent)
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: settings.userAgent });
}

export function extraTools(gateway: Gateway) {
  const showTab = {
    capability: 'core-tabs',
    schema: {
      name: 'browser_show_tab',
      title: 'Show a tab to the user',
      description: 'Bring the browser window to the front on one of your tabs, on the user\'s screen. Only when the ' +
        'user asks to see the page, or right after telling them you need them in it (login, captcha); it interrupts ' +
        'whatever they are doing.',
      inputSchema: z.object({
        index: z.number().optional().describe('Tab index from browser_tabs. Defaults to the current tab.'),
      }),
      type: 'readOnly',
    },
    handle: async (context: any, params: { index?: number }, response: any) => {
      const tab = params.index === undefined ? await context.ensureTab() : context.tabs()[params.index];
      if (!tab)
        throw new Error(`Tab ${params.index} not found`);
      await gateway.shared.focusTab(await gateway.shared.targetId(tab.page));
      response.addTextResult('The window is now in front on this tab.');
    },
  };

  const deviceNames = Object.keys(playwright.devices);
  const emulate = {
    capability: 'core',
    schema: {
      name: 'browser_emulate_device',
      title: 'Emulate a device',
      description: 'Emulate a device in the current tab only: viewport, device scale factor, mobile mode, touch and ' +
        'user agent. Other tabs and agents are not affected. Pass reset to go back to the normal desktop page.',
      inputSchema: z.object({
        device: z.string().optional().describe('Playwright device name, for example "iPhone 15" or "Pixel 7".'),
        width: z.number().optional(),
        height: z.number().optional(),
        deviceScaleFactor: z.number().optional(),
        mobile: z.boolean().optional(),
        touch: z.boolean().optional(),
        userAgent: z.string().optional(),
        reset: z.boolean().optional(),
      }),
      type: 'action',
    },
    handle: async (context: any, params: any, response: any) => {
      const tab = await context.ensureTab();
      const page: Page = tab.page;
      const session = context._agentSession;
      const targetId = await gateway.shared.targetId(page);
      if (params.reset) {
        await applyEmulation(page, undefined);
        session.emulation.delete(targetId);
        response.addTextResult('Device emulation reset.');
        return;
      }
      let device: any = {};
      if (params.device) {
        device = playwright.devices[params.device];
        if (!device)
          throw new Error(`Unknown device "${params.device}". Some known devices: ${deviceNames.filter(n => !n.includes('landscape')).slice(0, 40).join(', ')}`);
      }
      const width = params.width ?? device.viewport?.width;
      const height = params.height ?? device.viewport?.height;
      if (!width || !height)
        throw new Error('Pass a device name or width and height.');
      const mobile = params.mobile ?? device.isMobile ?? false;
      const settings: Emulation = {
        width, height, mobile,
        deviceScaleFactor: params.deviceScaleFactor ?? device.deviceScaleFactor ?? 1,
        touch: params.touch ?? device.hasTouch ?? mobile,
        userAgent: params.userAgent ?? device.userAgent,
      };
      await applyEmulation(page, settings);
      // Kept by the session, to apply again after a reconnect or restart.
      session.emulation.set(targetId, settings);
      response.addTextResult(`Emulating ${params.device ?? `${width}x${height}`} in this tab` +
        `${settings.userAgent ? ' (user agent changed; reload the page for sites that detect it on the server)' : ''}.`);
    },
  };

  const permission = {
    capability: 'core',
    schema: {
      name: 'browser_permission',
      title: 'Answer a permission request',
      description: 'Allow or deny what a site asks for (camera, microphone, location, notifications, ...). The browser ' +
        'never shows permission prompts: requests are listed under "Permission requests" in tool results, and this ' +
        'answers them. Without permissions it answers every open request of your tabs; with permissions (and ' +
        'optionally origin) it can also set them ahead of time for the current site. Allow only what the task needs.',
      inputSchema: z.object({
        decision: z.enum(['allow', 'deny']),
        permissions: z.array(z.string()).optional().describe(`Which ones: ${Object.keys(permissionTypes).join(', ')}. Default: all open requests.`),
        origin: z.string().optional().describe('Site origin, e.g. https://meet.google.com. Default: the requesting site, or the current tab\'s site.'),
      }),
      type: 'action',
    },
    handle: async (context: any, params: { decision: 'allow' | 'deny'; permissions?: string[]; origin?: string }, response: any) => {
      const session = [...gateway.sessions.values()].find(s => s.backend?._context === context);
      if (!session)
        throw new Error('No browser session for this call.');
      response.addTextResult(await gateway.answerPermissions(session, params.decision, params.permissions, params.origin, context.currentTab()?.page));
    },
  };

  return [showTab, emulate, permission];
}
