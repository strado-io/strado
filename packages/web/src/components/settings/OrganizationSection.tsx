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
          ? `Invited ${email} — we emailed them.`
          : `Invited ${email}, but the email could not be sent. Ask them to sign in with that address and accept in Settings → Organization.`,
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

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium text-zinc-300">Organization</h3>
        {editingName ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              aria-label="Organization name"
              className="rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              autoFocus
            />
            <button
              disabled={renaming || !nameDraft.trim()}
              onClick={saveRename}
              className="rounded bg-emerald-700 px-2 py-1 text-xs text-white disabled:opacity-50"
            >
              {renaming ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setEditingName(false)}
              className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <p className="text-sm text-zinc-200">{view.active.name}</p>
            {isOwner && (
              <button
                onClick={() => {
                  setNameDraft(view.active.name);
                  setEditingName(true);
                }}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Rename
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-600">Plan</h4>
        <div className="mt-1 flex items-center gap-2">
          <PlanBadge plan={view.entitlements?.plan} />
          <p className="text-sm text-zinc-400">
            {view.entitlements?.plan === 'pro'
              ? 'Cloud features enabled — runners, remote worktrees, sandboxes, Jira & Linear.'
              : 'Local features only. Cloud features (runners, remote, sandboxes, Jira & Linear) need Pro.'}
          </p>
        </div>
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-600">Members</h4>
        <ul className="mt-1 space-y-1">
          {view.members.map((m) => {
            const isMe = !!myEmail && m.email.toLowerCase() === myEmail.toLowerCase();
            return (
              <li key={m.email} className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1 text-sm">
                <span className="text-zinc-300">
                  {m.name || m.email} <span className="text-zinc-600">({m.email})</span>{' '}
                  <span className="text-zinc-500">· {m.role}</span>
                  {isMe && <span className="ml-1 text-xs text-emerald-400">you</span>}
                </span>
                {isOwner && !isMe && (
                  <button
                    disabled={busyEmail === m.email}
                    onClick={() => removeMember(m.email)}
                    className="text-xs text-zinc-500 hover:text-red-300 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {isOwner && view.members.length > 1 && (
          <p className="mt-1 text-xs text-zinc-600">
            Removing someone ends their access to this org, but existing sessions on
            runners they already opened may persist briefly — revoke the runner to
            cut access immediately.
          </p>
        )}
      </div>

      {view.invitations.outgoing.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-600">Pending invitations</h4>
          <ul className="mt-1 space-y-1">
            {view.invitations.outgoing.map((inv) => (
              <li
                key={inv.email}
                className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-300"
              >
                <span>{inv.email}</span>
                {isOwner && (
                  <button
                    disabled={busyEmail === inv.email}
                    onClick={() => cancelInvite(inv.email)}
                    className="text-xs text-zinc-500 hover:text-red-300 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.invitations.incoming.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-600">Invitations for you</h4>
          <ul className="mt-1 space-y-1">
            {view.invitations.incoming.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-300"
              >
                <span>
                  {inv.orgName} <span className="text-zinc-600">(invited by {inv.invitedBy})</span>
                </span>
                <span className="flex gap-2">
                  <button
                    disabled={busyInvitationId === inv.id}
                    onClick={() => acceptInvite(inv.id)}
                    className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    disabled={busyInvitationId === inv.id}
                    onClick={() => declineInvite(inv.id)}
                    className="text-xs text-zinc-500 hover:text-red-300 disabled:opacity-50"
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isOwner && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-600">Invite</h4>
          <div className="flex items-center gap-2">
            <input
              aria-label="Invite by email"
              type="email"
              placeholder="email address"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value);
                setInviteStatus(null);
              }}
              className="w-full rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            />
            <button
              disabled={inviting || !inviteEmail.trim()}
              onClick={sendInvite}
              className="shrink-0 rounded bg-emerald-700 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {inviting ? 'Inviting…' : 'Invite'}
            </button>
          </div>
          {inviteStatus && <p className="text-xs text-zinc-500">{inviteStatus}</p>}
          <p className="text-xs text-zinc-600">
            Anyone you invite can see and open every runner in this organization.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-red-300">{error}</p>}

      <div className="border-t border-zinc-900 pt-3">
        <button
          disabled={leaving}
          onClick={leave}
          className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-red-900/40 hover:text-red-200 disabled:opacity-50"
        >
          {leaving ? 'Leaving…' : 'Leave organization'}
        </button>
        {leaveRefusal && (
          <p className="mt-2 text-xs text-red-300">
            {leaveRefusal.kind === 'orphans_runners' &&
              `Can't leave — this org has runners only visible here: ${leaveRefusal.runners.join(', ')}. Revoke them first, or transfer ownership.`}
            {leaveRefusal.kind === 'last_owner' &&
              `Can't leave — you're the only owner and ${leaveRefusal.members} other member${
                leaveRefusal.members === 1 ? '' : 's'
              } would be left without one. Promote another member to owner first.`}
            {leaveRefusal.kind === 'other' && leaveRefusal.message}
          </p>
        )}
      </div>
    </section>
  );
}
