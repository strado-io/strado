// Signed-in state in Settings, following GithubSection's shape.
import { useEffect, useState } from 'react';
import { api, type StoredLicense } from '../../api';
import { LoginPanel } from '../LoginPanel';

export function AccountSection({ reload = () => window.location.reload() }: { reload?: () => void } = {}) {
  const [license, setLicense] = useState<StoredLicense | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = () =>
    api.license
      .get()
      .then(({ license }) => setLicense(license))
      .finally(() => setLoaded(true));

  useEffect(() => {
    void refresh();
  }, []);

  if (!loaded) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-zinc-300">Account</h3>
      {license ? (
        <>
          <p className="text-sm text-zinc-400">
            Signed in as <span className="text-zinc-200">{license.email ?? license.name}</span>
          </p>
          <button
            className="self-start rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
            onClick={async () => {
              await api.auth.signout();
              // Reload rather than lifted state: the gate remounts, finds no
              // license, renders locked — and every in-memory remnant of the
              // session goes with it.
              reload();
            }}
          >
            Sign out
          </button>
        </>
      ) : (
        <LoginPanel onSignedIn={refresh} />
      )}
    </section>
  );
}
