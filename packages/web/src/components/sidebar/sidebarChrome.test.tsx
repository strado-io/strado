import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarNav } from './SidebarNav';
import { FocusList } from './FocusList';
import { SpaceDots } from './SpaceDots';
import { SidebarToggleButton } from '../SidebarToggle';
import { UpdateFooter, type UpdateFooterProps } from '../UpdateFooter';

// The left sidebar's chrome in the right side's look: h-7 w-7 rounded-md icon
// buttons with 14px icons, the active one a .tab-pill, the Focus row a
// .tab-bar container, the update a small card.
const svgSize = (el: Element) => el.querySelector('svg')?.getAttribute('width');
const quietButton = (el: HTMLElement) => {
  expect(el.className).toMatch(/\bh-7\b/);
  expect(el.className).toMatch(/\bw-7\b/);
  expect(el.className).toMatch(/\brounded-md\b/);
  expect(el.className).toMatch(/\btext-zinc-500\b/);
  expect(el.className).toMatch(/hover:text-zinc-200/);
  expect(svgSize(el)).toBe('14');
};

describe('sidebar chrome', () => {
  it('bottom nav: quiet 28px buttons with 14px icons; the current page is a tab pill', () => {
    render(<SidebarNav selected={{ kind: 'usage' }} onSelect={vi.fn()} onOpenSettings={vi.fn()} />);
    // One glass bar, 40px, like a pane card.
    const nav = screen.getByTestId('sidebar-nav');
    expect(nav.className).toMatch(/\bglass\b/);
    expect(nav.className).toMatch(/\bpane-card\b/);
    expect(nav.className).toMatch(/\bh-10\b/);
    quietButton(screen.getByRole('button', { name: 'Worktrees' }));
    quietButton(screen.getByRole('button', { name: 'Open settings' }));
    const usage = screen.getByRole('button', { name: 'Usage' });
    expect(usage).toHaveAttribute('aria-current', 'page');
    expect(usage.className).toMatch(/\btab-pill\b/);
    expect(usage.className).toMatch(/\btext-zinc-100\b/);
    expect(screen.getByRole('button', { name: 'Worktrees' }).className).not.toMatch(/tab-pill/);
  });

  it('the Focus list has no header: no caption, no + of its own (New focus is in the workspace row)', () => {
    const focus = { id: 'f', name: 'test 2', members: [], createdAt: 't', lastActiveAt: 't' };
    render(<FocusList focuses={[focus]} activeId="f" badges={new Map()} activeMenu={[]} onOpen={vi.fn()} onRename={vi.fn()}>cards</FocusList>);
    expect(screen.queryByText(/^Focuses$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'New focus' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'test 2' })).toBeInTheDocument();
  });

  it('« is a 14px panel icon in the same quiet button', () => {
    render(<SidebarToggleButton open onClick={vi.fn()} />);
    const b = screen.getByRole('button', { name: 'Collapse sidebar' });
    quietButton(b);
    expect(b).not.toHaveTextContent('«');
  });

  it('an available update is a small card with an amber accent, not a bare coloured line', () => {
    const props: UpdateFooterProps = { phase: 'available', info: { updateAvailable: true, version: '0.2.0', mandatory: false } as UpdateFooterProps['info'], progress: 0, error: null, mode: 'swap', onUpdate: vi.fn(), onInstall: vi.fn(), onDismiss: vi.fn() };
    render(<UpdateFooter {...props} />);
    const card = screen.getByTestId('update-card');
    expect(card.className).toMatch(/\btab-bar\b/);
    expect(card.className).toMatch(/rounded-\[10px\]/);
    expect(card.querySelector('[data-testid="update-accent"]')!.className).toMatch(/\bbg-amber-400\b/);
    expect(screen.getByRole('button', { name: 'Update to 0.2.0' }).className).toMatch(/\btext-zinc-200\b/);
  });

  it('space dots: subtle; the current one a short zinc-400 bar, the rest dim and steady on hover', () => {
    const spaces = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] as Parameters<typeof SpaceDots>[0]['spaces'];
    render(<SpaceDots spaces={spaces} activeId="b" onSelect={vi.fn()} />);
    expect(screen.getByTestId('space-dot-b').className).toMatch(/\bbg-zinc-400\b/);
    expect(screen.getByTestId('space-dot-a').className).toMatch(/\bbg-zinc-700\b/);
    expect(screen.getByTestId('space-dot-a').className).not.toMatch(/scale-150/);
  });
});
