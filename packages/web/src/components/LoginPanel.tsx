// Device-code sign-in. The user_code is displayed prominently because the whole
// security property is the human comparing it against the browser before
// approving — see the spec, Section 1.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../api';

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting'; userCode: string; url: string }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

export function LoginPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const stop = useRef(false);

  // Switching Settings nav away from Profile (or closing the dialog) while a
  // sign-in is in flight unmounts this panel — without this, `begin`'s loop
  // below keeps polling in the background forever, since nothing else ever
  // sets `stop.current`.
  useEffect(() => {
    return () => {
      stop.current = true;
    };
  }, []);

  const begin = useCallback(async () => {
    stop.current = false;
    setPhase({ kind: 'idle' });
    let grant: Awaited<ReturnType<typeof api.auth.start>>;
    try {
      grant = await api.auth.start();
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'sign-in unavailable' });
      return;
    }
    setPhase({ kind: 'waiting', userCode: grant.userCode, url: grant.verificationUrl });
    // Opening in the system browser rather than a window inside the shell: a
    // session cookie must not live in the app that composites the preview.
    window.open(grant.verificationUrl, '_blank', 'noopener,noreferrer');

    let interval = Math.max(0, grant.interval) * 1000;
    while (!stop.current) {
      if (interval) await new Promise((r) => setTimeout(r, interval));
      // Re-checked after every await, not only at the top of the loop. The
      // unmount cleanup can land while this iteration is asleep or while its
      // request is in flight, and acting on what comes back is not a harmless
      // straggler: LicenseGate passes onSignedIn={() => window.location.reload()},
      // so it reloads the app out from under whatever the user moved on to.
      if (stop.current) return;
      let res: Awaited<ReturnType<typeof api.auth.poll>>;
      try {
        res = await api.auth.poll(grant.userCode);
      } catch (err) {
        if (stop.current) return;
        // request() only throws ApiClientError when fetch() succeeded and the
        // server answered with a non-2xx status — a real network blip (local
        // server unreachable, DNS, connection refused) throws a plain
        // TypeError instead. Only the former is a terminal "the server said
        // no"; retrying forever on it is the same silent-loop bug as an
        // unhandled poll status, just arriving as an HTTP error instead of a
        // status field (e.g. `unknown_user_code` after a local-server restart
        // mid-poll wipes its in-memory pending map).
        if (err instanceof ApiClientError) {
          return setPhase({ kind: 'error', message: `Sign-in failed (${err.message}). Please try again.` });
        }
        continue; // a genuine network blip must not end the attempt
      }
      if (stop.current) return;
      // Every branch here must either keep polling or land on a phase the
      // human can see and act on — silently looping on an unhandled status
      // leaves them staring at a code with no way out.
      switch (res.status) {
        case 'signed_in':
          return onSignedIn();
        case 'expired':
          return setPhase({ kind: 'expired' });
        case 'authorization_pending':
          break; // keep polling
        case 'slow_down':
          // the server asked us to back off, so back off
          interval = Math.max(interval * 2, 2000);
          break;
        default:
          // A status this build doesn't know about. Retrying forever would
          // be silently wrong; an honest, visible error is the safe default.
          return setPhase({ kind: 'error', message: `Unexpected sign-in status: ${res.status}` });
      }
    }
  }, [onSignedIn]);

  if (phase.kind === 'waiting') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-zinc-400">Confirm this code in your browser:</p>
        <p className="rounded bg-zinc-900 py-3 text-center font-mono text-2xl tracking-[0.2em] text-zinc-100">
          {phase.userCode}
        </p>
        <p className="text-xs text-zinc-600">
          A tab should have opened. If not,{' '}
          <a className="underline" href={phase.url} target="_blank" rel="noopener noreferrer">
            open it here
          </a>
          . You can click the emailed link on any device.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {phase.kind === 'expired' && <p className="text-sm text-amber-400">That sign-in attempt expired.</p>}
      {phase.kind === 'error' && <p className="text-sm text-red-400">{phase.message}</p>}
      <button
        className="rounded bg-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white"
        onClick={begin}
      >
        {phase.kind === 'idle' ? 'Sign in with email' : 'Try again'}
      </button>
    </div>
  );
}
