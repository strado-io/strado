import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { initTelemetry, track } from '../telemetry';
import { LoginPanel } from './LoginPanel';
import { FirstRunCard, ghostButtonClass } from './FirstRunCard';

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
      <FirstRunCard
        title="Reconnect to Strado"
        lede="This install hasn't been able to confirm its license in a while, and the offline grace period has run out. Reconnect to the internet and retry, or sign in again."
        footer={<PairingFooter apiUrl={apiUrl} />}
      >
        {/* Retry stays a ghost button so the card carries a single orange
            primary — the sign-in path below, which is the one that works
            regardless of what the license server says. */}
        <button
          onClick={() => void retry()}
          disabled={retrying}
          className={`${ghostButtonClass} w-full px-3 py-[0.72rem] text-[0.95rem] font-semibold`}
        >
          {retrying ? 'Checking…' : 'Retry'}
        </button>
        <div className="my-4 flex items-center gap-3 text-[0.68rem] uppercase tracking-[0.2em] text-zinc-500">
          <div className="h-px flex-1 bg-zinc-700" />
          or
          <div className="h-px flex-1 bg-zinc-700" />
        </div>
        <LoginPanel onSignedIn={() => window.location.reload()} />
      </FirstRunCard>
    );
  }

  return (
    <FirstRunCard
      title="Welcome to Strado"
      lede="This beta requires an account."
      footer={<PairingFooter apiUrl={state.apiUrl} />}
    >
      <LoginPanel onSignedIn={() => window.location.reload()} />
    </FirstRunCard>
  );
}

// Names the host the device code is confirmed against, so a self-hosted or
// staging endpoint is visible rather than implied.
function PairingFooter({ apiUrl }: { apiUrl: string }) {
  return (
    <>
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="flex-none opacity-85"
        aria-hidden="true"
      >
        <rect x="4" y="10.5" width="16" height="10" rx="2.2" />
        <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      </svg>
      secure pairing · {hostOf(apiUrl)}
    </>
  );
}

// A configured value that isn't a URL is shown verbatim instead of crashing
// the one screen that must render.
function hostOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}
