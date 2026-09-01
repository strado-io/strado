import { useEffect, useState } from 'react';
import { api, type StoredLicense } from '../../api';
import { LoginPanel } from '../LoginPanel';

function accountInitial(license: StoredLicense): string {
  return (license.name || license.email || '?').trim().charAt(0).toUpperCase() || '?';
}

export function AccountSection({ reload = () => window.location.reload() }: { reload?: () => void } = {}) {
  const [license, setLicense] = useState<StoredLicense | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api.license
      .get()
      .then(({ license: storedLicense }) => setLicense(storedLicense))
      .catch(() => setLicense(null))
      .finally(() => setLoaded(true));

  useEffect(() => {
    void refresh();
  }, []);

  if (!loaded) {
    return (
      <section aria-label="Account" className="animate-pulse">
        <div className="mb-3 h-4 w-20 rounded bg-zinc-900" />
        <div className="h-16 rounded-lg bg-zinc-900/30" />
      </section>
    );
  }

  const signOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await api.auth.signout();
      // Reload rather than lifting auth state: the gate remounts without any
      // in-memory remnants of the signed-in session.
      reload();
    } catch (signOutError) {
      setError((signOutError as Error).message);
      setSigningOut(false);
    }
  };

  return (
    <section aria-labelledby="account-title">
      <h2 id="account-title" className="mb-3 text-sm font-medium text-zinc-200">Account</h2>

      {license ? (
        <div className="rounded-lg bg-zinc-900/35 p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-xs font-semibold text-zinc-300">
              {accountInitial(license)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-zinc-200">{license.email ?? license.name}</span>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                  Signed in
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={signingOut}
              onClick={() => void signOut()}
              className="shrink-0 rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          {error && <div role="alert" className="mt-3 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>}
        </div>
      ) : (
        <div className="rounded-lg bg-zinc-900/35 p-4">
          <LoginPanel onSignedIn={refresh} />
        </div>
      )}
    </section>
  );
}
