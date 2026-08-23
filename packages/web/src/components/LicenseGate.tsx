import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { initTelemetry, track } from '../telemetry';
import { LoginPanel } from './LoginPanel';

// Sign-in gate for shipped builds. Dev servers report required:false and
// render straight through. Once signed in the app works offline — a failed
// verification is ignored; only an explicit "revoked" answer locks the app.
//
// 'stale' is distinct from 'locked': the install still has a license, but the
// local server's own grace-window check (licenseState()) says it hasn't been
// confirmed in too long. Treating that the same as 'open' would render a
// shell whose every API call silently 401s underneath it — the whole point of
// showing this screen is that the human gets something to act on instead.
export function LicenseGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'open' }
    | { kind: 'locked'; apiUrl: string }
    | { kind: 'stale'; apiUrl: string }
  >({ kind: 'loading' });
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let alive = true;
    api.license
      .get()
      .then(async ({ required, apiUrl, telemetry, license, status }) => {
        if (!alive) return;
        if (!required) setState({ kind: 'open' });
        else if (!license) setState({ kind: 'locked', apiUrl });
        else if (status === 'stale') setState({ kind: 'stale', apiUrl });
        else setState({ kind: 'open' });

        if (required && license) {
          const { telemetryOptOut } = await api.profile.get().catch(() => ({ telemetryOptOut: false }));
          initTelemetry({ apiUrl, token: license.token, enabled: telemetry !== false && !telemetryOptOut });
          track('app_launched');
          // background revocation check — fire and forget, offline tolerated.
          // The local server owns this now — it is what records the verification
          // and what clears a revoked license. Firing this on every mount (not
          // only when the button below is clicked) is also what self-heals a
          // 'stale' launch back to 'open' the moment the cloud is reachable,
          // without the human needing to do anything.
          api.license
            .verify()
            .then((r) => {
              if (!alive) return;
              if (r.ok) setState({ kind: 'open' });
              else if (r.reason === 'revoked') setState({ kind: 'locked', apiUrl });
              // any other reason (unreachable/unconfirmed) — leave state as is
            })
            .catch(() => undefined); // offline is not revoked
        }
      })
      .catch(() => {
        // local server unreachable — the app shell will surface that itself
        if (alive) setState({ kind: 'open' });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === 'open') return <>{children}</>;
  if (state.kind === 'loading') return <div className="h-screen bg-zinc-950" />;

  if (state.kind === 'stale') {
    const apiUrl = state.apiUrl;
    const retry = async () => {
      setRetrying(true);
      try {
        const r = await api.license.verify();
        if (r.ok) setState({ kind: 'open' });
        else if (r.reason === 'revoked') setState({ kind: 'locked', apiUrl });
        // still unreachable/unconfirmed — stay put, they can try again
      } finally {
        setRetrying(false);
      }
    };
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 p-4">
        <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
          <h1 className="text-lg font-semibold text-zinc-100">Reconnect to Strado</h1>
          <p className="mt-1 text-sm text-zinc-500">
            This install hasn&apos;t been able to confirm its license in a while, and the
            offline grace period has run out. Reconnect to the internet and retry, or sign
            in again.
          </p>
          <button
            onClick={() => void retry()}
            disabled={retrying}
            className="mt-4 h-10 w-full rounded bg-sky-700 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {retrying ? 'Checking…' : 'Retry'}
          </button>
          <div className="my-4 flex items-center gap-2 text-xs text-zinc-600">
            <div className="h-px flex-1 bg-zinc-800" />
            or
            <div className="h-px flex-1 bg-zinc-800" />
          </div>
          <LoginPanel onSignedIn={() => window.location.reload()} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        <h1 className="text-lg font-semibold text-zinc-100">Welcome to Strado</h1>
        <p className="mt-1 text-sm text-zinc-500">This beta requires an account.</p>
        <div className="mt-4">
          <LoginPanel onSignedIn={() => window.location.reload()} />
        </div>
      </div>
    </div>
  );
}
