import { RunningServers } from '../RunningServers';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    quietButton(screen.getByRole('button', { name: 'Code reviews' }));
    quietButton(screen.getByRole('button', { name: 'Open settings' }));
    const usage = screen.getByRole('button', { name: 'Usage' });
    expect(usage).toHaveAttribute('aria-current', 'page');
    expect(usage.className).toMatch(/\btab-pill\b/);
    expect(usage.className).toMatch(/\btext-zinc-100\b/);
    expect(screen.getByRole('button', { name: 'Code reviews' }).className).not.toMatch(/tab-pill/);
  });

  it('bottom nav: what is running sits right after Usage, before Settings', () => {
    render(<SidebarNav selected={null} onSelect={vi.fn()} onOpenSettings={vi.fn()} running={<button type="button">2 running</button>} />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['Code reviews', 'Usage', '2 running', 'Open settings']);
  });

  it('bottom bar: running is an icon and a count; its list floats above it like a tooltip, arrow on the icon', () => {
    const w = { path: '/r/a', branch: 'a', meta: {}, process: { status: 'running', port: 3002 } } as unknown as import('../../types').Worktree;
    render(<RunningServers worktrees={[w]} onOpen={vi.fn()} onStop={vi.fn()} onKillExternal={vi.fn()} placement="up" />);
    const chip = screen.getByRole('button', { name: 'Running dev servers' });
    expect(chip).toHaveTextContent(/^1$/);
    expect(chip.querySelector('svg')).not.toBeNull();
    fireEvent.click(chip);
    const arrow = screen.getByTestId('running-arrow');
    const pop = arrow.parentElement!;
    // Portalled to the body (fixed at the chip), so the panes can't cover it.
    expect(pop.parentElement).toBe(document.body);
    expect(pop.className.split(/\s+/)).toEqual(expect.arrayContaining(['menu-solid', 'fixed', 'w-max']));
    expect(pop).toHaveTextContent('a');
    expect(pop).toHaveTextContent(':3002');
  });

  it('the Focus list has no header: no caption, no + of its own (New focus is in the workspace row)', () => {
    const focus = { id: 'f', name: 'test 2', members: [], createdAt: 't', lastActiveAt: 't' };
    render(<FocusList focuses={[focus]} activeId="f" badges={new Map()} activeMenu={[]} onOpen={vi.fn()} onRename={vi.fn()}>{() => 'cards'}</FocusList>);
    expect(screen.queryByText(/^Focuses$/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'New focus' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'test 2' })).toBeInTheDocument();
  });

  it('Focus rows are headings, not cards: flat with a theme-aware hover tint; the open one\'s contents sit in one quiet group', () => {
    const f = (id: string, name: string, at: string) => ({ id, name, members: [], createdAt: 't', lastActiveAt: at });
    sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['a']));
    render(<FocusList focuses={[f('a', 'Open one', '2026-03-01'), f('b', 'Other', '2026-02-01')]} activeId="a" badges={new Map()} activeMenu={[]} onOpen={vi.fn()} onRename={vi.fn()}>
      {() => <div data-testid="cards">cards</div>}
    </FocusList>);
    const row = screen.getByRole('button', { name: 'Switch to Other' }).parentElement!;
    for (const cls of ['glass', 'pane-card', 'border', 'rounded-xl']) expect(row.className.split(/\s+/)).not.toContain(cls);
    for (const cls of ['h-8', 'px-2', 'rounded-md', 'hover:bg-[rgb(var(--pane-edge)/0.05)]']) expect(row.className.split(/\s+/)).toContain(cls);
    expect(row.querySelectorAll('svg')).toHaveLength(1); // the chevron; no Focus icon
    expect(within(row).getByText('Other').className).toMatch(/text-\[13px\].*font-medium/);
    // The open Focus's header uses the same row; its contents are grouped, no accent line.
    const header = screen.getByTestId('focus-header');
    expect(header).toContainElement(screen.getByRole('heading', { name: 'Open one' }));
    expect(header.className.split(/\s+/)).toEqual(expect.arrayContaining(['px-2', 'rounded-md']));
    const group = screen.getByTestId('focus-group');
    expect(group).toContainElement(screen.getByTestId('cards'));
    for (const cls of ['rounded-xl', 'p-1.5', 'gap-1.5', 'ring-1', 'bg-[rgb(var(--pane-edge)/0.02)]', 'ring-[rgb(var(--pane-edge)/0.05)]']) expect(group.className.split(/\s+/)).toContain(cls);
    expect(group.className).not.toMatch(/border-l/);
    // A gap between the open group and the rows below, inside the panel; the rows stack tightly.
    expect(group.parentElement!.className.split(/\s+/)).toContain('pb-2');
    expect(row.parentElement!.parentElement!.className.split(/\s+/)).toContain('gap-0.5');
  });

  it('expanding or folding a Focus never moves its row: same classes either way; only the panel, below, grows and shrinks', () => {
    const f = (id: string, name: string, at: string) => ({ id, name, members: [], createdAt: at, lastActiveAt: at });
    sessionStorage.setItem('strado:focus-expanded', JSON.stringify(['a']));
    render(<FocusList focuses={[f('a', 'Open one', '2026-03-01'), f('b', 'Other', '2026-03-02')]} activeId="a" badges={new Map()} activeMenu={[]} onOpen={vi.fn()} onRename={vi.fn()}
      jarvis={{ status: null, selected: false, onOpen: vi.fn() }}>
      {() => <div data-testid="cards">cards</div>}
    </FocusList>);
    const items = () => [...document.querySelectorAll<HTMLElement>('[data-focus-item]')];
    const shape = () => items().map((el) => [el.className, el.firstElementChild!.className]);
    const before = shape();
    // No margins on an item: spacing is the list's gap, the same folded or not.
    for (const [cls] of before) expect(cls).toBe('flex flex-col');
    // The panel carries the gaps, inside the clip that grows (grid rows, .focus-panel),
    // so it can shut all the way to 0 with no padding left to snap away.
    const gaps = screen.getByTestId('focus-group').parentElement!;
    const clip = gaps.parentElement!;
    const panel = clip.parentElement!;
    expect(panel.className).toBe('focus-panel');
    expect(panel).toHaveAttribute('data-open');
    expect(clip.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-0', 'overflow-hidden']));
    expect(clip.className).not.toMatch(/\bp[tby]-/);
    expect(gaps.className.split(/\s+/)).toContain('pt-0.5');

    fireEvent.click(screen.getByRole('button', { name: 'Fold Open one' }));
    expect(screen.queryByTestId('focus-group')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show Other' }));
    expect(shape()).toEqual(before);
  });

  it('the panel glides on the drawer ease, its contents fade in behind it, and nothing moves with reduced motion', () => {
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
    expect(css).toMatch(/--ease-drawer: cubic-bezier\(0\.32, 0\.72, 0, 1\);/);
    expect(css).toMatch(/\.focus-panel \{[^}]*grid-template-rows: 0fr;[^}]*transition: grid-template-rows 220ms var\(--ease-drawer\);/);
    expect(css).toMatch(/\.focus-panel\[data-open\] \{ grid-template-rows: 1fr; transition-duration: 280ms; \}/);
    expect(css).toMatch(/\.focus-panel\[data-open\] > \* > \* \{[^}]*opacity: 1;/);
    // Only a panel just toggled open grows in: one that reappears with the app (back from Settings) doesn't.
    expect(css).toMatch(/@starting-style \{[^@]*\.focus-panel\[data-open\]\[data-enter\] \{ grid-template-rows: 0fr; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.focus-panel, \.focus-panel > \* > \* \{ transition: none; \} \}/);
  });

  it('popups (menus, popovers, tooltips, dialogs) and the sidebar ease in on the same curve; reduced motion stills them', () => {
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
    expect(css).toMatch(/\.surface-pop, \.menu-solid, \[role='menu'\], \[role='listbox'\], \[role='tooltip'\], \[role='dialog'\]:not\(\.fixed\),\s+\.fixed\.inset-0\[class\*='bg-black\/'\] > \* \{\s+transition: opacity 160ms ease-out, scale 220ms var\(--ease-drawer\)/);
    expect(css).toMatch(/@starting-style \{[^@]*opacity: 0; scale: 0\.97; translate: 0 -4px;/);
    expect(css).toMatch(/\.sidebar-slide\[data-collapsed\] \{ margin-left: calc\(-1 \* var\(--sidebar-w\)\);/);
    expect(css).toMatch(/@starting-style \{ \.sidebar-slide\[data-slide-in\] \{ margin-left: calc\(-1 \* var\(--sidebar-w\)\); \} \}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s+\.surface-pop[^}]*\.sidebar-slide, \.open-sidebar-slot \{ transition: none; \}/);
    // A toolbar's room for the open button opens and shuts with the sidebar, on the same timing.
    expect(css).toMatch(/\.open-sidebar-slot \{[^}]*grid-template-columns: 0fr;[^}]*transition: grid-template-columns 260ms var\(--ease-drawer\);/);
    expect(css).toMatch(/\.open-sidebar-slot\[data-shown\] \{ grid-template-columns: 1fr; transition-duration: 220ms; \}/);
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
