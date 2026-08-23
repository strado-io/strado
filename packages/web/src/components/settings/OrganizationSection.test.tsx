import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const orgGet = vi.hoisted(() => vi.fn());
const orgInvite = vi.hoisted(() => vi.fn());
const orgCancelInvite = vi.hoisted(() => vi.fn());
const orgRename = vi.hoisted(() => vi.fn());
const orgRemoveMember = vi.hoisted(() => vi.fn());
const orgAccept = vi.hoisted(() => vi.fn());
const orgDecline = vi.hoisted(() => vi.fn());
const orgLeave = vi.hoisted(() => vi.fn());
const licenseGet = vi.hoisted(() => vi.fn());

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return {
    ...actual,
    api: {
      org: {
        get: orgGet,
        invite: orgInvite,
        cancelInvite: orgCancelInvite,
        rename: orgRename,
        removeMember: orgRemoveMember,
        accept: orgAccept,
        decline: orgDecline,
        leave: orgLeave,
      },
      license: { get: licenseGet },
    },
  };
});

import { ApiClientError } from '../../api';
import { OrganizationSection } from './OrganizationSection';

const ownerView = {
  active: { id: 'org-1', name: 'Acme', kind: 'team', role: 'owner' },
  orgs: [{ id: 'org-1', name: 'Acme', kind: 'team', role: 'owner' }],
  members: [
    { email: 'owner@x.io', name: 'Owner Person', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
    { email: 'member@x.io', name: 'Member Person', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' },
  ],
  invitations: {
    outgoing: [{ email: 'pending@x.io', invitedAt: '2026-01-03T00:00:00.000Z', expiresAt: '2026-01-10T00:00:00.000Z' }],
    incoming: [{ id: 'inv-1', orgId: 'org-2', orgName: 'Other Org', invitedBy: 'boss@other.io', expiresAt: '2026-01-10T00:00:00.000Z' }],
  },
};

const memberView = {
  ...ownerView,
  active: { ...ownerView.active, role: 'member' },
};

function licenseAs(email: string) {
  return { required: true, apiUrl: '', license: { email, token: 't', name: 'Someone', deviceId: 'd' }, status: 'ok' as const };
}

beforeEach(() => {
  orgGet.mockReset();
  orgInvite.mockReset();
  orgCancelInvite.mockReset();
  orgRename.mockReset();
  orgRemoveMember.mockReset();
  orgAccept.mockReset();
  orgDecline.mockReset();
  orgLeave.mockReset();
  licenseGet.mockReset();
});

describe('OrganizationSection', () => {
  it('renders members with their roles', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));

    render(<OrganizationSection />);

    await screen.findByText(/owner@x\.io/);
    expect(screen.getByText(/member@x\.io/)).toBeInTheDocument();
    expect(screen.getAllByText(/owner/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/member/i).length).toBeGreaterThan(0);
  });

  it('renders Accept/Decline for an incoming invitation', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));

    render(<OrganizationSection />);

    await screen.findByText(/Other Org/);
    expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('clicking Invite calls api.org.invite with the typed address', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgInvite.mockResolvedValue({ ok: true, emailed: true });

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    const input = screen.getByLabelText(/invite by email/i);
    await userEvent.type(input, 'new-teammate@x.io');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    await waitFor(() => expect(orgInvite).toHaveBeenCalledWith('new-teammate@x.io'));
    // sendInvite() re-fetches the view afterward — let that settle too, so no
    // state update lands after this test has already torn down.
    await waitFor(() => expect(orgGet).toHaveBeenCalledTimes(2));
  });

  it('shows a status line confirming the invite was emailed', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgInvite.mockResolvedValue({ ok: true, emailed: true });

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    const input = screen.getByLabelText(/invite by email/i);
    await userEvent.type(input, 'new-teammate@x.io');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    await screen.findByText('Invited new-teammate@x.io — we emailed them.');
    // Let sendInvite()'s trailing refresh() settle too, same reasoning as the
    // "clicking Invite" test above.
    await waitFor(() => expect(orgGet).toHaveBeenCalledTimes(2));
  });

  it('shows a status line telling the owner to pass the word manually when mail could not be sent', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgInvite.mockResolvedValue({ ok: true, emailed: false });

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    const input = screen.getByLabelText(/invite by email/i);
    await userEvent.type(input, 'new-teammate@x.io');
    await userEvent.click(screen.getByRole('button', { name: /^invite$/i }));

    await screen.findByText(
      'Invited new-teammate@x.io, but the email could not be sent. Ask them to sign in with that address and accept in Settings → Organization.',
    );
    await waitFor(() => expect(orgGet).toHaveBeenCalledTimes(2));
  });

  it('hides owner-only controls (Invite, Rename, Cancel, Remove) for a member', async () => {
    orgGet.mockResolvedValue(memberView);
    licenseGet.mockResolvedValue(licenseAs('member@x.io'));

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    expect(screen.queryByRole('button', { name: /^invite$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    // Accept/Decline are personal, not owner-gated — still present.
    expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
  });

  it('marks the signed-in member as "you"', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    expect(screen.getByText('you')).toBeInTheDocument();
  });

  it('surfaces the orphans_runners reason, naming the runners, when leaving fails', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgLeave.mockRejectedValue(
      new ApiClientError('VALIDATION', 'strado-api 409', { error: 'orphans_runners', runners: ['box-1', 'box-2'] }),
    );

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);
    await userEvent.click(screen.getByRole('button', { name: /leave/i }));

    await screen.findByText(/box-1/);
    expect(screen.getByText(/box-2/)).toBeInTheDocument();
  });

  it('surfaces the last_owner reason, naming how many members remain, when leaving fails', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgLeave.mockRejectedValue(
      new ApiClientError('VALIDATION', 'strado-api 409', { error: 'last_owner', members: 3 }),
    );

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);
    await userEvent.click(screen.getByRole('button', { name: /leave/i }));

    await screen.findByText(/3/);
  });

  it('leaving successfully reloads the window — runners and remote worktrees are org-scoped and cached in state', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgLeave.mockResolvedValue({ ...ownerView, active: { id: 'org-2', name: 'Other', kind: 'personal', role: 'owner' } });
    const reload = vi.fn();

    render(<OrganizationSection reload={reload} />);
    await screen.findByText(/owner@x\.io/);
    await userEvent.click(screen.getByRole('button', { name: /leave/i }));

    await waitFor(() => expect(orgLeave).toHaveBeenCalled());
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('accepting an invitation successfully reloads the window, the same way switching does', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgAccept.mockResolvedValue(ownerView);
    const reload = vi.fn();

    render(<OrganizationSection reload={reload} />);
    await screen.findByText(/Other Org/);
    await userEvent.click(screen.getByRole('button', { name: /accept/i }));

    await waitFor(() => expect(orgAccept).toHaveBeenCalledWith('inv-1'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('a failed accept shows a plain sentence for a known reason, never the raw API error text, and refreshes so the dead row disappears', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgAccept.mockRejectedValue(
      new ApiClientError('VALIDATION', 'strado-api 410: {"error":"cannot accept","reason":"gone"}', {
        error: 'cannot accept',
        reason: 'gone',
      }),
    );
    const reload = vi.fn();

    render(<OrganizationSection reload={reload} />);
    await screen.findByText(/Other Org/);
    await userEvent.click(screen.getByRole('button', { name: /accept/i }));

    await screen.findByText('That invitation has expired or was withdrawn.');
    expect(screen.queryByText(/strado-api 410/)).not.toBeInTheDocument();
    // The view is refreshed (not reloaded — the accept never succeeded) so a
    // now-dead invitation row doesn't sit there un-actionable.
    await waitFor(() => expect(orgGet).toHaveBeenCalledTimes(2));
    expect(reload).not.toHaveBeenCalled();
  });

  it('a failed decline falls back to a generic message for an unmapped reason, and still refreshes', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));
    orgDecline.mockRejectedValue(new ApiClientError('VALIDATION', 'strado-api 404: {"error":"no such invitation"}'));

    render(<OrganizationSection />);
    await screen.findByText(/Other Org/);
    await userEvent.click(screen.getByRole('button', { name: /decline/i }));

    await screen.findByText('Failed to decline invitation');
    expect(screen.queryByText(/strado-api 404/)).not.toBeInTheDocument();
    await waitFor(() => expect(orgGet).toHaveBeenCalledTimes(2));
  });

  it('names the org-only sole member sole owner and hides the runner-persistence note when there is no one else to remove', async () => {
    const soloView = { ...ownerView, members: [ownerView.members[0]] };
    orgGet.mockResolvedValue(soloView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    expect(screen.queryByText(/existing sessions on/i)).not.toBeInTheDocument();
  });

  it('warns that removing someone does not immediately cut off a runner session already in use', async () => {
    orgGet.mockResolvedValue(ownerView);
    licenseGet.mockResolvedValue(licenseAs('owner@x.io'));

    render(<OrganizationSection />);
    await screen.findByText(/owner@x\.io/);

    expect(screen.getByText(/existing sessions on/i)).toBeInTheDocument();
  });
});
