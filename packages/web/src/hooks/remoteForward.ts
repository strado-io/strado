// Port forwarding for a remote hub.
//
// The whole point: with the forward up, the preview browser and the browser MCP
// keep working unchanged — they see 127.0.0.1 and never learn the bytes came
// from a VM.
import { useEffect, useState } from 'react';
import { api, type Forward } from '../api';

/** Hosts a dev server on the runner reports for itself. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::]', '::', '::1']);

/**
 * Rewrite a URL the RUNNER reported so it points at the local end of the
 * forward, keeping path, query and hash.
 *
 * Returns null when it cannot be resolved — deliberately not the original URL.
 * `http://localhost:3000` from a runner names port 3000 on THIS machine, so
 * passing it through would quietly show whatever is running here instead. A
 * visible "not ready yet" beats confidently rendering the wrong app.
 */
export function localizeRemoteUrl(raw: string, forward: Forward | null): string | null {
  if (!forward) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return forward.url;
  }
  // A non-loopback host is reachable on its own terms (a staging URL someone set
  // as an override) and must not be rerouted through the tunnel.
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return raw;
  url.protocol = 'http:';
  url.hostname = '127.0.0.1';
  url.port = String(forward.localPort);
  return url.toString();
}

export type RemoteForwardState = {
  forward: Forward | null;
  error: string | null;
  pending: boolean;
};

/**
 * Keep a forward open for one runner port.
 *
 * Does NOT close the forward on unmount. Switching hubs would otherwise kill a
 * real browser tab the user opened against the local port, and the child's idle
 * timeout already reaps forwards nothing is using.
 */
export function useRemoteForward(runnerId: string | null, remotePort: number | null): RemoteForwardState {
  const [state, setState] = useState<RemoteForwardState>({ forward: null, error: null, pending: false });

  useEffect(() => {
    if (!runnerId || !remotePort) {
      setState({ forward: null, error: null, pending: false });
      return;
    }
    let live = true;
    setState((s) => ({ forward: s.forward, error: null, pending: true }));
    api.runners.forwards
      .open(runnerId, remotePort)
      .then((forward) => {
        if (live) setState({ forward, error: null, pending: false });
      })
      .catch((err: Error) => {
        // Named, not swallowed: "port 3000 is not forwardable on this runner"
        // is the difference between a fixable setup problem and a mystery.
        if (live) setState({ forward: null, error: err.message, pending: false });
      });
    return () => {
      live = false;
    };
  }, [runnerId, remotePort]);

  return state;
}
