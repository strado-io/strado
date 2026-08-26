import { useEffect, useRef, useState } from 'react';
import { api, type Profile, type StoredLicense } from '../api';
import { useOrg } from '../hooks/org';
import { PlanBadge } from './OrgChip';

type SettingsTarget = 'profile' | 'organization';

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}

function MenuIcon({ kind }: { kind: 'settings' | 'organization' | 'feedback' | 'signout' }) {
  if (kind === 'organization') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 13.5V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v10.5M10 6.5h2.5a1 1 0 0 1 1 1v6M1.5 13.5h13" />
      </svg>
    );
  }
  if (kind === 'feedback') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3.5h12v8H8l-3 2.5v-2.5H2z" />
      </svg>
    );
  }
  if (kind === 'signout') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2.5H3.5v11H6M9.5 5 13 8l-3.5 3M13 8H6" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
    </svg>
  );
}

export function AccountMenu({
  onOpenSettings,
  onOpenFeedback,
  reload = () => window.location.reload(),
}: {
  onOpenSettings: (section: SettingsTarget) => void;
  onOpenFeedback: () => void;
  reload?: () => void;
}) {
  const { view, switchTo } = useOrg();
  const [license, setLicense] = useState<StoredLicense | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.license?.get?.().then(({ license: next }) => setLicense(next)).catch(() => setLicense(null));
    api.profile?.get?.().then(setProfile).catch(() => setProfile(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const displayName =
    profile?.callMe?.trim() || profile?.fullName?.trim() || license?.name?.trim() || license?.email || 'Account';
  const avatarName = profile?.fullName?.trim() || license?.name?.trim() || displayName;
  const activeOrg = view?.active.name;
  const hasIncoming = (view?.invitations.incoming.length ?? 0) > 0;
  const itemClass = 'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';

  async function pickOrganization(orgId: string) {
    setOpen(false);
    if (!view || orgId === view.active.id) return;
    setBusy(true);
    try {
      await switchTo(orgId);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Account: ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-50"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-medium text-zinc-200">
          {initials(avatarName)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {busy ? 'Switching…' : displayName}
          {activeOrg && <span className="text-zinc-500"> · {activeOrg}</span>}
        </span>
        <PlanBadge plan={view?.entitlements?.plan} />
        {hasIncoming && <span aria-label="pending invitation" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
        <svg className="shrink-0 text-zinc-600" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute bottom-full left-0 z-50 mb-1 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-medium text-zinc-200">
              {initials(avatarName)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm text-zinc-100">{displayName}</span>
              {license?.email && <span className="block truncate text-xs text-zinc-500">{license.email}</span>}
            </span>
          </div>

          {view && (
            <>
              <div className="my-1 border-t border-zinc-800" />
              <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                Organizations
              </div>
              {view.orgs.map((organization) => {
                const active = organization.id === view.active.id;
                return (
                  <button
                    key={organization.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => void pickOrganization(organization.id)}
                    className={itemClass}
                  >
                    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[9px] text-zinc-300">
                      {initials(organization.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                    {active && <span aria-hidden className="text-emerald-400">✓</span>}
                  </button>
                );
              })}
            </>
          )}

          <div className="my-1 border-t border-zinc-800" />
          <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onOpenSettings('profile'); }}>
            <MenuIcon kind="settings" /> Settings
          </button>
          {view && (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onOpenSettings('organization'); }}>
              <MenuIcon kind="organization" /> Organization settings
            </button>
          )}
          <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onOpenFeedback(); }}>
            <MenuIcon kind="feedback" /> Send feedback
          </button>

          {license && (
            <>
              <div className="my-1 border-t border-zinc-800" />
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.auth.signout();
                    reload();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <MenuIcon kind="signout" /> Sign out
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
