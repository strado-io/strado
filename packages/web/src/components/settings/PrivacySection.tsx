import { useEffect, useState } from 'react';
import { api } from '../../api';

export function PrivacySection() {
  const [optOut, setOptOut] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profile.get().then((p) => setOptOut(p.telemetryOptOut)).catch(() => setOptOut(false));
  }, []);

  if (optOut === null) return <div className="text-sm text-zinc-600">Loading…</div>;

  const toggle = async () => {
    const next = !optOut;
    setOptOut(next);
    setError(null);
    try {
      await api.profile.save({ telemetryOptOut: next });
    } catch (e) {
      setOptOut(!next);
      setError((e as Error).message);
    }
  };

  return (
    <div className="max-w-lg">
      <h2 className="mb-4 text-base font-semibold text-zinc-100">Privacy</h2>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label="Send anonymous usage counts"
          checked={!optOut}
          onChange={toggle}
          className="mt-0.5 h-4 w-4 accent-sky-600"
        />
        <span>
          <span className="text-sm text-zinc-200">Send anonymous usage counts</span>
          <span className="block text-xs text-zinc-500">
            Counters and feature names only — never code, paths, branches, or ticket content. Takes effect next launch.
          </span>
        </span>
      </label>
      {error && <div className="mt-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <p className="mt-6 text-xs leading-relaxed text-zinc-500">
        Your code, sessions, and tracking data stay on localhost. The only outbound traffic is the Jira calls you
        configure and, in gated builds, invite-status checks plus these anonymous counts.
      </p>
    </div>
  );
}
