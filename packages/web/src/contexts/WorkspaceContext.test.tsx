import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'react';
import { WorkspaceProvider, WorkspaceContext, type WorkspaceContextValue } from './WorkspaceContext';
import { api } from '../api';

const ACME = {
  id: 'default',
  name: 'Acme',
  color: '#3b82f6',
  icon: 'F',
  defaultEditor: 'code' as const,
  defaultPortBase: 8080,
  logDir: null,
};

vi.mock('../api', () => ({
  api: {
    workspaces: {
      list: vi.fn(async () => ({ activeWorkspaceId: 'default', workspaces: [ACME] })),
      setActive: vi.fn(),
    },
  },
}));

// Follows the pattern in pages/TerminalView.test.tsx: stub global fetch and
// branch on the URL rather than mocking the capabilities hook module.
function stubCapabilities(profile: 'stable' | 'dev' | undefined) {
  vi.stubGlobal('fetch', async (url: string) =>
    String(url).includes('/api/capabilities')
      ? ({ ok: true, json: async () => (profile === undefined ? {} : { profile }) } as Response)
      : ({ ok: false, json: async () => ({}) } as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('WorkspaceProvider window title', () => {
  it('uses the plain "Strado" title when the server reports the stable profile', async () => {
    stubCapabilities('stable');
    render(
      <WorkspaceProvider wsId="default" onSwitchTo={() => {}}>
        <div />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(document.title).toBe('F Strado — Acme'));
  });

  it('falls back to "Strado" when an older server omits profile entirely', async () => {
    stubCapabilities(undefined);
    render(
      <WorkspaceProvider wsId="default" onSwitchTo={() => {}}>
        <div />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(document.title).toBe('F Strado — Acme'));
  });

  it('announces "Strado Dev" once capabilities resolve to the dev profile', async () => {
    stubCapabilities('dev');
    render(
      <WorkspaceProvider wsId="default" onSwitchTo={() => {}}>
        <div />
      </WorkspaceProvider>,
    );
    await waitFor(() => expect(document.title).toBe('F Strado Dev — Acme'));
  });
});

// The swipe has already moved the pixels by the time switchTo runs, and the
// pane the user is looking at stays inert until `workspace` changes — so the
// switch must not wait on the network to become visible.
describe('WorkspaceProvider switchTo', () => {
  const STRADO = { ...ACME, id: 'strado', name: 'Strado' };

  function harness() {
    vi.mocked(api.workspaces.list).mockResolvedValue({
      activeWorkspaceId: 'default',
      workspaces: [ACME, STRADO],
    });
    stubCapabilities('stable');
    let ctx: WorkspaceContextValue | null = null;
    const onSwitchTo = vi.fn();
    const Probe = () => {
      ctx = useContext(WorkspaceContext);
      return <span data-testid="active">{ctx?.workspace.name}</span>;
    };
    render(
      <WorkspaceProvider wsId="default" onSwitchTo={onSwitchTo}>
        <Probe />
      </WorkspaceProvider>,
    );
    return { get ctx() { return ctx!; }, onSwitchTo };
  }

  it('shows the new workspace before the server confirms it', async () => {
    let settle: (() => void) | null = null;
    vi.mocked(api.workspaces.setActive).mockImplementation(
      () => new Promise((res) => { settle = () => res({ activeWorkspaceId: 'strado' }); }) as never,
    );
    const h = harness();
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent('Acme'));

    let done = false;
    const pending = h.ctx.switchTo('strado').then(() => { done = true; });
    // The POST has not resolved, so this is the optimistic state or nothing.
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent('Strado'));
    expect(done).toBe(false);
    expect(h.onSwitchTo).toHaveBeenCalledWith('strado');

    settle!();
    await pending;
  });

  it('puts the old workspace back when the server refuses', async () => {
    vi.mocked(api.workspaces.setActive).mockRejectedValue(new Error('nope'));
    const h = harness();
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent('Acme'));
    await expect(h.ctx.switchTo('strado')).rejects.toThrow('nope');
    await waitFor(() => expect(screen.getByTestId('active')).toHaveTextContent('Acme'));
  });
});
