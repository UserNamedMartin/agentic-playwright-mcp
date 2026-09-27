// No connection an agent's call opens from the gateway process may reach the
// browser's DevTools port or the gateway itself: the DevTools HTTP endpoint
// lists and closes every chat's tabs. Pages cannot get there (the proxy sees
// every navigation, see proxy.ts), but browser_run_code_unsafe also makes
// requests from this process (page.request, context.request, route.fetch),
// each redirect hop a new connection. Instead of wrapping each of those, every
// socket opened on an agent's behalf is checked, by address once the name is
// resolved. "On an agent's behalf" is an async context: its calls, and its
// session's Playwright connection with everything it does later (route
// handlers, event listeners, redirects).
import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';
import { isLoopback } from './urls.js';

// Set around each agent call and its Playwright connection (see session.ts);
// ports it may not reach.
export const agentCall = new AsyncLocalStorage<{ internalPorts: () => string[] }>();

let installed = false;

export function installNetGuard() {
  if (installed)
    return;
  installed = true;
  const connect = net.Socket.prototype.connect as any;
  net.Socket.prototype.connect = function(this: net.Socket, ...args: any[]) {
    const call = agentCall.getStore();
    if (!call)
      return connect.apply(this, args);
    // net.connect() passes its arguments already normalized, as one array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    const port = String(options.port ?? '');
    const ports = call.internalPorts();
    // (http passes "path: null"; a string path is a local socket file.)
    if (typeof options.path !== 'string' && ports.includes(port)) {
      const refuse = () => this.destroy(Object.assign(new Error(`${options.host ?? 'localhost'}:${port} is not available to agents: the browser's DevTools port and the gateway's own pages act on every chat's tabs.`), { code: 'EAGENTREFUSED' }));
      const host = String(options.host ?? 'localhost');
      if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
        if (isLoopback(host)) {
          process.nextTick(refuse);
          return this;
        }
      } else {
        // A name: checked once resolved, before anything is sent.
        this.once('lookup', (error: Error | null, address: string) => {
          if (!error && isLoopback(address.includes(':') ? `[${address}]` : address))
            refuse();
        });
      }
    }
    return connect.apply(this, args);
  } as any;
}
