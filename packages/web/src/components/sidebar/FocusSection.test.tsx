import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FocusGroup } from '../../api';
import type { Worktree } from '../../types';
import type { SidebarEntry } from './pinIds';
import { FocusSection, type FocusSectionProps } from './FocusSection';

const g = (id: string, name: string): FocusGroup => ({ id, name, members: [], createdAt: 't' });
const entry = (path: string): SidebarEntry => ({ kind: 'local', pinId: `local:${path}`, repoId: 'r1', w: { path } as Worktree });

function props(over: Partial<FocusSectionProps> = {}): FocusSectionProps {
  return {
    groups: [g('g1', 'FX-412'), g('g2', 'Old work')],
    activeGroup: null, members: [], isDone: () => false,
    collapsed: false, onToggleCollapsed: vi.fn(),
    onActivate: vi.fn(), onCreate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
    renderMember: (e) => <div key={e.pinId}>row {e.pinId}</div>,
    ...over,
  };
}

describe('FocusSection', () => {
  // With no groups yet the picker is still the way in: it is where the first one is made.
  it('offers New group even when there are no groups', () => {
    const p = props({ groups: [] });
    render(<FocusSection {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Focus: none/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New group…' }));
    const input = screen.getByRole('textbox', { name: 'New group name' });
    fireEvent.change(input, { target: { value: 'FX-500' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCreate).toHaveBeenCalledWith('FX-500');
  });

  it('offers a picker when no group is active, and activates the chosen one', () => {
    const p = props();
    render(<FocusSection {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Focus: none/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'FX-412' }));
    expect(p.onActivate).toHaveBeenCalledWith('g1');
  });

  it('shows the active group members, and hides them when collapsed', () => {
    const active = g('g1', 'FX-412');
    const { rerender } = render(<FocusSection {...props({ activeGroup: active, members: [entry('/a'), entry('/b')] })} />);
    const section = screen.getByRole('region', { name: 'Focus group' });
    expect(within(section).getByText('row local:/a')).toBeInTheDocument();
    expect(within(section).getByText('row local:/b')).toBeInTheDocument();
    rerender(<FocusSection {...props({ activeGroup: active, members: [entry('/a')], collapsed: true })} />);
    expect(screen.queryByText('row local:/a')).not.toBeInTheDocument();
  });

  it('creates a group from the picker', () => {
    const p = props();
    render(<FocusSection {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Focus: none/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New group…' }));
    const input = screen.getByLabelText('New group name');
    fireEvent.change(input, { target: { value: 'FX-500' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onCreate).toHaveBeenCalledWith('FX-500');
  });

  it('prompts to delete a Done active group, and Keep dismisses it', () => {
    const active = g('g1', 'FX-412');
    const p = props({ activeGroup: active, members: [entry('/a')], isDone: (x) => x.id === 'g1' });
    render(<FocusSection {...p} />);
    expect(screen.getByText(/All merged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/All merged/)).not.toBeInTheDocument();
  });

  it('lists Done groups separately with a delete button', () => {
    const p = props({ isDone: (x) => x.id === 'g2' });
    render(<FocusSection {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Focus: none/ }));
    expect(screen.queryByRole('menuitemradio', { name: 'Old work' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Old work' }));
    expect(p.onDelete).toHaveBeenCalledWith('g2');
  });
});
