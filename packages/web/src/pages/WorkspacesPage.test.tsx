import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacesPage from './WorkspacesPage';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import type { Workspace } from '../types';

const ws = (id: string): Workspace => ({
  id, name: id.toUpperCase(), color: '#334455', icon: id[0]!,
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
});
const list = [ws('a'), ws('b'), ws('c')];

const ACME: Workspace = {
  id: 'default', name: 'Acme', color: '#3b82f6', icon: 'F',
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
};

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      workspaces: {
        ...actual.api.workspaces,
        list: vi.fn(async () => ({ activeWorkspaceId: 'a', workspaces: list })),
        reorder: vi.fn(async (ids: string[]) => ids.map((id) => ws(id))),
        remove: vi.fn(async () => {}),
      },
    },
  };
});
const { api } = await import('../api');

// RunnersPanel fetches on mount and is not what these tests are about.
vi.mock('../components/RunnersPanel', () => ({ RunnersPanel: () => null }));

const ROW_H = 40;
const TOP = 100;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const i = Number(this.dataset.index ?? 0);
    return { top: TOP + i * ROW_H, height: ROW_H, bottom: TOP + (i + 1) * ROW_H,
      left: 0, right: 200, width: 200, x: 0, y: TOP + i * ROW_H, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const refresh = vi.fn(async () => {});

function renderPage(workspaces: Workspace[] = list) {
  render(
    <WorkspaceContext.Provider
      value={{ workspace: workspaces[0]!, allWorkspaces: workspaces, refresh, switchTo: vi.fn() }}
    >
      <WorkspacesPage onClose={vi.fn()} />
    </WorkspaceContext.Provider>,
  );
}

async function dragFirstRowToEnd() {
  const handle = await screen.findByRole('button', { name: 'Reorder A' });
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: TOP + 10 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: TOP + 2 * ROW_H + 30 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: TOP + 2 * ROW_H + 30 });
}

/** A `reorder` that stays pending until the returned resolver is called. */
function pendingReorder() {
  let resolve!: (ws: Workspace[]) => void;
  const promise = new Promise<Workspace[]>((r) => { resolve = r; });
  vi.mocked(api.workspaces.reorder).mockImplementationOnce(() => promise);
  return (ids: string[]) => resolve(ids.map(ws));
}

function rowIds() {
  return screen.getAllByTestId(/^ws-row-/).map((el) => el.getAttribute('data-testid'));
}

describe('WorkspacesPage reordering', () => {
  it('persists the new order and refreshes the sidebar', async () => {
    renderPage();
    await dragFirstRowToEnd();
    await waitFor(() => expect(api.workspaces.reorder).toHaveBeenCalledWith(['b', 'c', 'a']));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('shows the new order immediately, before the request settles', async () => {
    const settle = pendingReorder();
    renderPage();
    await dragFirstRowToEnd();
    // `reorder` is still pending here — this is the assertion a
    // non-optimistic ("setState after the await") handler would fail.
    expect(rowIds()).toEqual(['ws-row-b', 'ws-row-c', 'ws-row-a']);
    settle(['b', 'c', 'a']);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('puts the old order back and explains itself when the save fails', async () => {
    vi.mocked(api.workspaces.reorder).mockRejectedValueOnce(new Error('nope'));
    renderPage();
    await dragFirstRowToEnd();
    await waitFor(() => expect(screen.getByText(/nope/)).toBeInTheDocument());
    expect(rowIds()).toEqual(['ws-row-a', 'ws-row-b', 'ws-row-c']);
  });

  it('does not revert an already-saved order when the sidebar refresh itself fails', async () => {
    refresh.mockRejectedValueOnce(new Error('sidebar refresh boom'));
    renderPage();
    await dragFirstRowToEnd();
    // The save (POST /api/workspaces/order) succeeded; only the best-effort
    // sidebar refresh after it failed. The rows must stay at the new order
    // and no error should blame the save for it.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(rowIds()).toEqual(['ws-row-b', 'ws-row-c', 'ws-row-a']);
    expect(screen.queryByText(/sidebar refresh boom/)).toBeNull();
  });

  it('takes the order the server stored, not the one the drag assumed', async () => {
    // The POST answers with the authoritative list; keeping the optimistic
    // copy means the dialog can sit on an order the server never applied.
    vi.mocked(api.workspaces.reorder).mockResolvedValueOnce([ws('c'), ws('b'), ws('a')]);
    renderPage();
    await dragFirstRowToEnd(); // the drag says b,c,a
    await waitFor(() => expect(rowIds()).toEqual(['ws-row-c', 'ws-row-b', 'ws-row-a']));
  });

  it('refuses Delete and New workspace while the order is still saving', async () => {
    // A delete landing between the optimistic apply and the POST makes the
    // order no longer a permutation: the save 400s, and the revert puts back a
    // list containing the workspace that was just deleted.
    const settle = pendingReorder();
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await dragFirstRowToEnd();

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    expect(api.workspaces.remove).not.toHaveBeenCalled();
    expect(confirmed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /\+ New workspace/ })).toBeDisabled();

    settle(['b', 'c', 'a']);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // …and both are live again once it lands.
    expect(screen.getByRole('button', { name: /\+ New workspace/ })).toBeEnabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(api.workspaces.remove).toHaveBeenCalled());
  });

  it('ignores a second drop while the first drop is still saving', async () => {
    const settle = pendingReorder();
    renderPage();
    await dragFirstRowToEnd(); // a,b,c -> b,c,a; save left pending
    expect(api.workspaces.reorder).toHaveBeenCalledTimes(1);

    // Same handle, same gesture, attempted again before the first save lands.
    await dragFirstRowToEnd();
    expect(api.workspaces.reorder).toHaveBeenCalledTimes(1);
    expect(rowIds()).toEqual(['ws-row-b', 'ws-row-c', 'ws-row-a']);

    settle(['b', 'c', 'a']);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe('WorkspacesPage', () => {
  it('renders existing workspaces', async () => {
    vi.mocked(api.workspaces.list).mockResolvedValueOnce({
      activeWorkspaceId: 'default', workspaces: [ACME],
    });
    renderPage([ACME]);
    expect(await screen.findByText('Acme')).toBeTruthy();
  });

  it('hides Delete when only one workspace exists', async () => {
    vi.mocked(api.workspaces.list).mockResolvedValueOnce({
      activeWorkspaceId: 'default', workspaces: [ACME],
    });
    renderPage([ACME]);
    await screen.findByText('Acme');
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });

  it('opens new workspace dialog when "+ New workspace" clicked', async () => {
    vi.mocked(api.workspaces.list).mockResolvedValueOnce({
      activeWorkspaceId: 'default', workspaces: [ACME],
    });
    renderPage([ACME]);
    await screen.findByText('Acme');
    fireEvent.click(screen.getByRole('button', { name: /\+ New workspace/ }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /New workspace/i })).toBeTruthy();
    });
  });
});
