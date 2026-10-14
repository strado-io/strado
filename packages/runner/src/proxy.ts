// Corporate proxies for the runner's own HTTP calls (pairing, release feed,
// tarball download, git credential requests).
//
// Node's fetch ignores HTTP(S)_PROXY on its own. The tunnel WebSocket already
// honours it (relay/client.ts); this covers every `fetch` in the daemon and
// the CLI by installing undici's env-driven dispatcher process-wide, once,
// after runner.env has been loaded — so a proxy set there counts too.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

let applied = false;

export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
}

/** Returns the proxy URL now in effect, or null when none is configured. */
export function applyProxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const proxy = proxyFromEnv(env);
  if (!proxy || applied) return proxy;
  // EnvHttpProxyAgent reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY itself and
  // routes each request by scheme and host, like curl does.
  setGlobalDispatcher(new EnvHttpProxyAgent());
  applied = true;
  return proxy;
}
