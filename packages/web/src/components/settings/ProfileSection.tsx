import { FormEvent, useEffect, useState } from 'react';
import { api, type Profile } from '../../api';

function initials(name: string, callMe: string): string {
  const source = name.trim() || callMe.trim();
  if (!source) return '?';
  const parts = source.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

const inputCls =
  'h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600';

export function ProfileSection() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [baseline, setBaseline] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.profile.get()
      .then((loaded) => {
        setProfile(loaded);
        setBaseline(loaded);
      })
      .catch(() => {
        const empty = { fullName: '', callMe: '', telemetryOptOut: false };
        setProfile(empty);
        setBaseline(empty);
      });
  }, []);

  if (!profile || !baseline) {
    return (
      <section aria-label="Personal details" className="animate-pulse">
        <div className="mb-3 h-4 w-32 rounded bg-zinc-900" />
        <div className="h-48 rounded-lg bg-zinc-900/30" />
      </section>
    );
  }

  const normalized = {
    fullName: profile.fullName.trim(),
    callMe: profile.callMe.trim(),
  };
  const dirty = normalized.fullName !== baseline.fullName.trim()
    || normalized.callMe !== baseline.callMe.trim();

  const update = (patch: Partial<Pick<Profile, 'fullName' | 'callMe'>>) => {
    setProfile((current) => current ? { ...current, ...patch } : current);
    setSaved(false);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await api.profile.save(normalized);
      setProfile(result);
      setBaseline(result);
      setSaved(true);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="personal-details-title">
      <h2 id="personal-details-title" className="mb-3 text-sm font-medium text-zinc-200">Personal details</h2>

      <form className="rounded-lg bg-zinc-900/35 p-4" onSubmit={save}>
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-sm font-semibold text-zinc-200">
            {initials(profile.fullName, profile.callMe)}
          </span>
          <div className="truncate text-sm font-medium text-zinc-200">
            {profile.fullName.trim() || 'Your profile'}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-300">Full name</span>
            <input
              aria-label="Full name"
              autoComplete="name"
              className={inputCls}
              value={profile.fullName}
              onChange={(event) => update({ fullName: event.target.value })}
              placeholder="Your name"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-300">Preferred name</span>
            <input
              aria-label="What should agents call you?"
              className={inputCls}
              value={profile.callMe}
              onChange={(event) => update({ callMe: event.target.value })}
              placeholder="What agents should call you"
            />
          </label>
        </div>

        {error && <div role="alert" className="mt-3 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>}

        <div className="mt-4 flex items-center justify-end gap-3">
          {saved && <span role="status" className="text-xs text-emerald-400">Changes saved</span>}
          <button
            type="submit"
            disabled={saving || !dirty}
            className="rounded-md bg-zinc-100 px-4 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </section>
  );
}
