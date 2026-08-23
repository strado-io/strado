// Sidebar footer chip for the active ORGANIZATION — distinct from the
// top-left WorkspaceSwitcher, which picks a local grouping of repos and has
// nothing to do with who else can see your runners. Hidden entirely when
// there's no org view (unauthenticated builds, or STRADO_LICENSE_REQUIRED
// off) so it never appears in a dev build.
//
// With exactly one org, clicking is a shortcut into Settings → Organization.
// With more than one, clicking opens a popover to switch — and switching
// reloads the window, because runners and remote worktrees are org-scoped
// and cached in component state; a reload is the only honest guarantee
// nothing cross-org survives (same reasoning as AccountSection's sign-out).
import { useState } from 'react';
import { useOrg } from '../hooks/org';
import type { PlanName } from '../api';

/** Small Free/Pro pill so the active plan is visible at a glance. */
export function PlanBadge({ plan }: { plan?: PlanName }) {
  if (!plan) return null;
  const pro = plan === 'pro';
  return (
    <span
      title={pro ? 'Pro plan — cloud features enabled' : 'Free plan — local features only'}
      className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-wide ring-1 ring-inset ${
        pro ? 'bg-sky-500/15 text-sky-300 ring-sky-500/30' : 'bg-zinc-800 text-zinc-500 ring-zinc-700'
      }`}
    >
      {plan}
    </span>
  );
}

function OrgIcon() {
  // A building glyph — deliberately not the workspace switcher's
  // initials-circle, so the two chips never read as the same control.
  return (
    <svg
      width="15" height="15" viewBox="0 0 16 16" aria-hidden
      className="shrink-0 text-zinc-600 group-hover:text-zinc-400"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M3 13.5V3a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v10.5" />
      <path d="M10 6.5h2.5a1 1 0 0 1 1 1v6" />
      <path d="M5 5h1.5M5 7.5h1.5M5 10h1.5" />
      <path d="M1.5 13.5h13" />
    </svg>
  );
}

export function OrgChip({
  onOpenSettings,
  reload = () => window.location.reload(),
}: {
  onOpenSettings: (section: 'organization') => void;
  reload?: () => void;
}) {
  const { view, switchTo } = useOrg();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  if (!view) return null;

  const hasIncoming = view.invitations.incoming.length > 0;
  const multi = view.orgs.length > 1;

  async function pick(orgId: string) {
    setOpen(false);
    if (orgId === view!.active.id) return;
    setSwitching(true);
    try {
      await switchTo(orgId);
      reload();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (multi ? setOpen((v) => !v) : onOpenSettings('organization'))}
        disabled={switching}
        aria-label={`Organization: ${view.active.name}`}
        className="group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-50"
      >
        <OrgIcon />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[10px] font-medium uppercase tracking-wide text-zinc-600">
            Organization
          </span>
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate">{switching ? 'Switching…' : view.active.name}</span>
            <PlanBadge plan={view.entitlements?.plan} />
          </span>
        </span>
        {hasIncoming && (
          <span
            aria-label="pending invitation"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
          />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label="Switch organization"
            className="absolute bottom-full left-0 z-50 mb-1 w-full min-w-52 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl"
          >
            <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
              Organization
            </div>
            {view.orgs.map((o) => {
              const active = o.id === view.active.id;
              return (
                <button
                  key={o.id}
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => pick(o.id)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-900 ${
                    active ? 'text-zinc-100' : 'text-zinc-300'
                  }`}
                >
                  <span className="w-3 shrink-0 text-emerald-400">{active ? '✓' : ''}</span>
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                </button>
              );
            })}
            <div className="my-1 border-t border-zinc-800" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenSettings('organization');
              }}
              className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            >
              Organization settings…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
