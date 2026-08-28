import { useEffect, useState } from 'react';
import { api, type Profile } from '../../api';

function initials(name: string, callMe: string): string {
  const src = name.trim() || callMe.trim();
  if (!src) return '?';
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function ProfileSection() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profile.get().then(setProfile).catch(() => setProfile({ fullName: '', callMe: '', telemetryOptOut: false }));
  }, []);

  if (!profile) return <div className="text-sm text-zinc-600">Loading…</div>;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.profile.save({ fullName: profile.fullName, callMe: profile.callMe });
      setProfile(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const labelCls = 'flex flex-col gap-1 text-xs text-zinc-400';
  const inputCls = 'rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none';

  return (
    <div className="max-w-lg">
      <h2 className="mb-4 text-base font-semibold text-zinc-100">Profile</h2>
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-200">
          {initials(profile.fullName, profile.callMe)}
        </span>
        <span className="text-xs text-zinc-500">Avatar is your initials.</span>
      </div>
      {error && <div className="mb-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div className="flex flex-col gap-3">
        <label className={labelCls}>
          Full name
          <input
            className={inputCls}
            value={profile.fullName}
            onChange={(e) => setProfile({ ...profile, fullName: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          What should agents call you?
          <input
            className={inputCls}
            value={profile.callMe}
            onChange={(e) => setProfile({ ...profile, callMe: e.target.value })}
          />
        </label>
      </div>
      <button
        onClick={save}
        disabled={saving}
        className="mt-4 rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

    </div>
  );
}
