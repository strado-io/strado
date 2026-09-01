// Settings → Organization: active org name (rename for owners), member list,
// invitations both ways, and Leave. Follows AccountSection's load-on-mount
// shape; the "you" marker and owner-only gating both key off the signed-in
// email from api.license.get() — the org view itself never asserts which
// member the caller is.
import { useEffect, useState } from 'react';
import { api, ApiClientError, type OrgView } from '../../api';
import { PlanBadge } from '../OrgChip';

type LeaveRefusal =
  | { kind: 'orphans_runners'; runners: string[] }
  | { kind: 'last_owner'; members: number }
  | { kind: 'other'; message: string };

// The cloud's org routes reply with structured 409/429/403/410 reasons
// (the cloud service's org routes) that cloudApi.ts now threads through as
// ApiClientError.details instead of flattening into a message string — this
// is the one place that structure needs to become copy a person can act on.
function parseLeaveRefusal(err: unknown): LeaveRefusal {
  if (err instanceof ApiClientError && err.details && typeof err.details === 'object') {
    const details = err.details as Record<string, unknown>;
    if (details.error === 'orphans_runners' && Array.isArray(details.runners)) {
      return { kind: 'orphans_runners', runners: details.runners as string[] };
    }
    if (details.error === 'last_owner' && typeof details.members === 'number') {
      return { kind: 'last_owner', members: details.members };
    }
  }
  return { kind: 'other', message: err instanceof Error ? err.message : 'Failed to leave organization' };
}

// accept/decline can fail with a structured `reason` (the cloud service's org
// routes: 'gone' | 'not_yours' | 'already_member' for accept; decline only
// ever 404s with no reason). Anything unmapped — including a plain
// Error/network failure — falls back to `fallback`, never the raw
// "strado-api 410: {...}" text a thrown ApiClientError carries.
function describeInviteActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.details && typeof err.details === 'object') {
    const reason = (err.details as Record<string, unknown>).reason;
    if (reason === 'gone') return 'That invitation has expired or was withdrawn.';
    if (reason === 'not_yours') return "That invitation wasn't sent to your email address.";
    if (reason === 'already_member') return "You're already a member of that organization.";
  }
  return fallback;
}

export function OrganizationSection({ reload = () => window.location.reload() }: { reload?: () => void } = {}) {
  const [view, setView] = useState<OrgView | null>(null);
  const [myEmail, setMyEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);

  const [leaving, setLeaving] = useState(false);
  const [leaveRefusal, setLeaveRefusal] = useState<LeaveRefusal | null>(null);

  const refresh = () =>
    Promise.all([api.org.get(), api.license.get()])
      .then(([org, lic]) => {
        setView(org);
        setMyEmail(lic.license?.email ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load organization'))
      .finally(() => setLoaded(true));

  useEffect(() => {
    void refresh();
  }, []);

  if (!loaded) return null;
  if (!view) {
    return <p className="text-sm text-red-300">{error ?? 'Failed to load organization'}</p>;
  }

  const isOwner = view.active.role === 'owner';

  async function saveRename() {
    const name = nameDraft.trim();
    if (!name) return;
    setRenaming(true);
    setError(null);
    setInviteStatus(null);
    try {
      setView(await api.org.rename(name));
      setEditingName(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rename organization');
    } finally {
      setRenaming(false);
    }
  }

  async function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    setError(null);
    setInviteStatus(null);
    try {
      const result = await api.org.invite(email);
      setInviteEmail('');
      setInviteStatus(
        result.emailed
          ? `Invitation sent to ${email}.`
          : `Invitation created for ${email}, but email delivery failed.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to invite');
    } finally {
      setInviting(false);
    }
  }

  async function cancelInvite(email: string) {
    setBusyEmail(email);
    setError(null);
    setInviteStatus(null);
    try {
      await api.org.cancelInvite(email);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to cancel invitation');
    } finally {
      setBusyEmail(null);
    }
  }

  async function removeMember(email: string) {
    setBusyEmail(email);
    setError(null);
    setInviteStatus(null);
    try {
      setView(await api.org.removeMember(email));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member');
    } finally {
      setBusyEmail(null);
    }
  }

  async function acceptInvite(id: string) {
    setBusyInvitationId(id);
    setError(null);
    setInviteStatus(null);
    try {
      await api.org.accept(id);
      // Accepting moves the accepting device's active org server-side (same
      // as switch), and runners/remote worktrees are cached per-org in other
      // components' state — reload is the only honest guarantee none of that
      // survives, same reasoning as OrgChip's switch and AccountSection's
      // sign-out.
      reload();
    } catch (e) {
      setError(describeInviteActionError(e, 'Failed to accept invitation'));
      // The invite may be gone (expired/withdrawn/already used) — refresh so
      // a dead row disappears rather than sitting there un-actionable.
      await refresh();
    } finally {
      setBusyInvitationId(null);
    }
  }

  async function declineInvite(id: string) {
    setBusyInvitationId(id);
    setError(null);
    setInviteStatus(null);
    try {
      await api.org.decline(id);
      await refresh();
    } catch (e) {
      setError(describeInviteActionError(e, 'Failed to decline invitation'));
      await refresh();
    } finally {
      setBusyInvitationId(null);
    }
  }

  async function leave() {
    setLeaving(true);
    setLeaveRefusal(null);
    setError(null);
    setInviteStatus(null);
    try {
      await api.org.leave();
      // Leaving changes the device's active org server-side just like
      // switching does — runners, remote worktrees and their polls are
      // org-scoped and cached in component state, so this reloads for the
      // same reason OrgChip's switch does.
      reload();
    } catch (e) {
      setLeaveRefusal(parseLeaveRefusal(e));
    } finally {
      setLeaving(false);
    }
  }

  const inputCls = 'h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600';

  return (
    <section className="max-w-2xl">
      <header className="mb-7 pr-10">
        {editingName ? (
          <div className="flex max-w-md items-center gap-2">
            <input
              aria-label="Organization name"
              className={inputCls}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              autoFocus
            />
            <button
              type="button"
              disabled={renaming || !nameDraft.trim()}
              onClick={() => void saveRename()}
              className="rounded-md bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
            >
              {renaming ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditingName(false)} className="rounded-md px-2.5 py-2 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200">
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <h1 className="truncate text-lg font-semibold text-zinc-100">{view.active.name}</h1>
            <PlanBadge plan={view.entitlements?.plan} />
            {isOwner && (
              <button
                type="button"
                aria-label="Rename organization"
                onClick={() => {
                  setNameDraft(view.active.name);
                  setEditingName(true);
                }}
                className="rounded-md p-1 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 11.5-.5 2 2-.5 7.8-7.8-1.5-1.5z" /><path d="m9.8 4.7 1.5 1.5" />
                </svg>
              </button>
            )}
          </div>
        )}
      </header>

      {view.invitations.incoming.length > 0 && (
        <section className="mb-7">
          <h2 className="mb-3 text-sm font-medium text-zinc-200">Invitations</h2>
          <ul className="space-y-2">
            {view.invitations.incoming.map((invitation) => (
              <li key={invitation.id} className="flex items-center gap-3 rounded-lg bg-zinc-900/35 p-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-xs font-semibold text-zinc-300">
                  {invitation.orgName.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-200">{invitation.orgName}</div>
                  <div className="mt-0.5 truncate text-xs text-zinc-600">From {invitation.invitedBy}</div>
                </div>
                <button
                  type="button"
                  disabled={busyInvitationId === invitation.id}
                  onClick={() => void acceptInvite(invitation.id)}
                  className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
                >
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busyInvitationId === invitation.id}
                  onClick={() => void declineInvite(invitation.id)}
                  className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                >
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium text-zinc-200">
            Members <span className="ml-1 font-normal text-zinc-600">{view.members.length}</span>
          </h2>
        </div>

        {isOwner && (
          <form
            className="mb-4 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void sendInvite();
            }}
          >
            <input
              aria-label="Invite by email"
              type="email"
              placeholder="Invite by email"
              value={inviteEmail}
              onChange={(event) => {
                setInviteEmail(event.target.value);
                setInviteStatus(null);
              }}
              className={inputCls}
            />
            <button
              type="submit"
              disabled={inviting || !inviteEmail.trim()}
              className="shrink-0 rounded-md bg-zinc-100 px-4 py-2 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
            >
              {inviting ? 'Inviting…' : 'Invite'}
            </button>
          </form>
        )}

        {inviteStatus && <p role="status" className="mb-3 text-xs text-zinc-500">{inviteStatus}</p>}

        <ul className="space-y-2">
          {view.members.map((member) => {
            const isMe = !!myEmail && member.email.toLowerCase() === myEmail.toLowerCase();
            return (
              <li key={member.email} className="flex items-center gap-3 rounded-lg bg-zinc-900/35 px-3.5 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-300">
                  {(member.name || member.email).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-zinc-200">{member.name || member.email}</span>
                    {isMe && <span className="shrink-0 text-[10px] text-emerald-400">you</span>}
                  </div>
                  {member.name && <div className="mt-0.5 truncate text-xs text-zinc-600">{member.email}</div>}
                </div>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] capitalize text-zinc-500">{member.role}</span>
                {isOwner && !isMe && (
                  <button
                    type="button"
                    disabled={busyEmail === member.email}
                    onClick={() => void removeMember(member.email)}
                    className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}

          {view.invitations.outgoing.map((invitation) => (
            <li key={invitation.email} className="flex items-center gap-3 rounded-lg bg-zinc-900/20 px-3.5 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs text-zinc-600">@</span>
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">{invitation.email}</span>
              <span className="rounded bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-600">Pending</span>
              {isOwner && (
                <button
                  type="button"
                  disabled={busyEmail === invitation.email}
                  onClick={() => void cancelInvite(invitation.email)}
                  className="rounded-md px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>

        {isOwner && view.members.length > 1 && (
          <p className="mt-2 text-[11px] text-zinc-600">Runner sessions can remain active briefly after member removal.</p>
        )}
      </section>

      {error && <div role="alert" className="mt-4 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-300">{error}</div>}

      <div className="mt-8">
        <div className="flex justify-end">
          <button
            type="button"
            disabled={leaving}
            onClick={() => void leave()}
            className="rounded-md border border-red-900/60 bg-red-950/20 px-3.5 py-2 text-xs font-medium text-red-400 hover:border-red-800 hover:bg-red-950/50 hover:text-red-300 disabled:opacity-40"
          >
            {leaving ? 'Leaving…' : 'Leave organization'}
          </button>
        </div>
        {leaveRefusal && (
          <p className="mt-2 text-right text-xs text-red-300">
            {leaveRefusal.kind === 'orphans_runners' &&
              `Can't leave — revoke these runners first: ${leaveRefusal.runners.join(', ')}.`}
            {leaveRefusal.kind === 'last_owner' &&
              `Can't leave — promote another owner for the remaining ${leaveRefusal.members} member${leaveRefusal.members === 1 ? '' : 's'}.`}
            {leaveRefusal.kind === 'other' && leaveRefusal.message}
          </p>
        )}
      </div>
    </section>
  );
}
