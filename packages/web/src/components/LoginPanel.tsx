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
        {/* The code is a terminal readout, matching the hosted approval page
            glyph-for-glyph: same label, same tracking, same orange. Two
            surfaces that look alike are what make the comparison feel like
            one act instead of two lookups. */}
        <div
          role="group"
          aria-label="Device code"
          className="flex flex-col gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-4 pb-[1.05rem] pt-4 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.4)]"
        >
          <span className="text-[0.62rem] uppercase tracking-[0.28em] text-zinc-500">device code</span>
          <span className="text-center indent-[0.32em] text-[1.9rem] font-bold tracking-[0.32em] text-sky-400 [text-shadow:0_0_22px_rgba(249,127,27,0.4)]">
            {phase.userCode}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          Confirm this matches the code in your browser. A tab should have opened — if not,{' '}
          <a className="text-sky-400 underline" href={phase.url} target="_blank" rel="noopener noreferrer">
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
        className="w-full rounded-[10px] border border-sky-400/20 bg-gradient-to-b from-[#c4550a] to-sky-700 px-3 py-[0.72rem] text-[0.95rem] font-semibold text-[#fbf3ea] shadow-[inset_0_1px_0_rgba(255,255,255,0.10)] transition hover:from-sky-600 hover:to-[#c4550a] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_6px_18px_-12px_rgba(226,103,10,0.55)] active:translate-y-px"
        onClick={begin}
      >
        {phase.kind === 'idle' ? 'Sign in' : 'Try again'}
      </button>
      {/* The button used to say "with email", but the page it opens offers a
          magic link, Google, and GitHub — naming one of the three read as a
          promise the browser then broke. Say where it goes and what's on
          offer instead. */}
      <p className="text-center text-xs leading-relaxed text-zinc-500">
        Opens a browser tab — email, Google, or GitHub.
      </p>
    </div>
  );
}
