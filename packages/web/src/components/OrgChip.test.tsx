import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const orgGet = vi.hoisted(() => vi.fn());
const orgSwitch = vi.hoisted(() => vi.fn());

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      org: {
        get: orgGet,
        switch: orgSwitch,
      },
    },
  };
});

import { OrgChip } from './OrgChip';

const single = {
  active: { id: 'org-1', name: 'Acme', kind: 'team', role: 'owner' },
  orgs: [{ id: 'org-1', name: 'Acme', kind: 'team', role: 'owner' }],
  members: [],
  invitations: { outgoing: [], incoming: [] },
};

const multi = {
  active: { id: 'org-1', name: 'Acme', kind: 'team', role: 'owner' },
  orgs: [
    { id: 'org-1', name: 'Acme', kind: 'team', role: 'owner' },
    { id: 'org-2', name: 'Widgets Co', kind: 'team', role: 'member' },
  ],
  members: [],
  invitations: { outgoing: [], incoming: [] },
};

beforeEach(() => {
  orgGet.mockReset();
  orgSwitch.mockReset();
});

describe('OrgChip', () => {
  it('renders nothing while there is no org view (unauthenticated, or the fetch failed)', async () => {
    orgGet.mockRejectedValue(new Error('no Strado account on this machine — sign in first'));
    const onOpenSettings = vi.fn();

    const { container } = render(<OrgChip onOpenSettings={onOpenSettings} />);

    await waitFor(() => expect(orgGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('with exactly one org, clicking opens Settings → Organization', async () => {
    orgGet.mockResolvedValue(single);
    const onOpenSettings = vi.fn();

    render(<OrgChip onOpenSettings={onOpenSettings} />);

    await screen.findByText('Acme');
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));

    expect(onOpenSettings).toHaveBeenCalledWith('organization');
    expect(orgSwitch).not.toHaveBeenCalled();
  });

  it('with more than one org, clicking opens a popover listing every org with the active one marked', async () => {
    orgGet.mockResolvedValue(multi);
    const onOpenSettings = vi.fn();

    render(<OrgChip onOpenSettings={onOpenSettings} />);

    await screen.findByText('Acme');
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));

    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Widgets Co')).toBeInTheDocument();
    const activeItem = screen.getByRole('menuitemradio', { name: /acme/i });
    expect(activeItem).toHaveAttribute('aria-checked', 'true');
    const otherItem = screen.getByRole('menuitemradio', { name: /widgets co/i });
    expect(otherItem).toHaveAttribute('aria-checked', 'false');
  });

  it('the popover offers a way into Organization settings, since the pending-invite dot has nowhere else to lead', async () => {
    orgGet.mockResolvedValue(multi);
    const onOpenSettings = vi.fn();

    render(<OrgChip onOpenSettings={onOpenSettings} />);

    await screen.findByText('Acme');
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    await userEvent.click(screen.getByRole('button', { name: /organization settings/i }));

    expect(onOpenSettings).toHaveBeenCalledWith('organization');
  });

  it('choosing another org calls api.org.switch then reloads only once that write resolves', async () => {
    orgGet.mockResolvedValue(multi);
    // A controlled deferred, not mockResolvedValue: invocationCallOrder only
    // records when a mock is *called*, not when its promise settles, so a
    // missing `await reload()` would still pass that assertion. Holding the
    // switch promise open and checking reload hasn't fired yet — then
    // resolving it and checking reload has — actually proves the ordering.
    let resolveSwitch!: (v: typeof multi) => void;
    orgSwitch.mockReturnValue(new Promise((resolve) => { resolveSwitch = resolve; }));
    const reload = vi.fn();

    render(<OrgChip onOpenSettings={vi.fn()} reload={reload} />);

    await screen.findByText('Acme');
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /widgets co/i }));

    await waitFor(() => expect(orgSwitch).toHaveBeenCalledWith('org-2'));
    // Reloading before the switch write resolves would blow away the
    // in-flight request and leave the device on the old org.
    expect(reload).not.toHaveBeenCalled();

    resolveSwitch({ ...multi, active: multi.orgs[1]! });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('shows a dot when there is a pending incoming invitation', async () => {
    orgGet.mockResolvedValue({
      ...single,
      invitations: {
        outgoing: [],
        incoming: [{ id: 'inv-1', orgId: 'org-9', orgName: 'Other', invitedBy: 'boss@x.io', expiresAt: '2026-01-10T00:00:00.000Z' }],
      },
    });

    render(<OrgChip onOpenSettings={vi.fn()} />);

    await screen.findByText('Acme');
    expect(screen.getByLabelText(/pending invitation/i)).toBeInTheDocument();
  });

  it('labels itself as an organization, distinct from the workspace switcher', async () => {
    orgGet.mockResolvedValue(multi);

    render(<OrgChip onOpenSettings={vi.fn()} />);

    await screen.findByText('Acme');
    await userEvent.click(screen.getByRole('button', { name: /acme/i }));

    expect(screen.getAllByText(/organization/i).length).toBeGreaterThan(0);
  });

  it('labels itself as an organization even with exactly one org', async () => {
    orgGet.mockResolvedValue(single);

    render(<OrgChip onOpenSettings={vi.fn()} />);

    await screen.findByText('Acme');
    expect(screen.getByText(/^organization$/i)).toBeInTheDocument();
  });
});
