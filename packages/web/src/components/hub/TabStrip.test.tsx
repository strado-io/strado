import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TabStrip, type StripEntry, type StripTab, type TabRename } from './TabStrip';

const t = (mode: string, id = '1'): StripTab => ({ path: '/wt/a', mode, id });
const entries: StripEntry<StripTab>[] = [
  { tab: t('claude'), label: 'Claude', icon: <svg data-testid="icon-claude" /> },
  { tab: t('shell'), label: 'Shell', icon: <svg data-testid="icon-shell" /> },
  { tab: t('shell', '2'), label: 'Shell 2', icon: <svg /> },
  { tab: t('browser'), label: 'Docs', icon: <svg /> },
];

function Harness(over: Partial<ComponentProps<typeof TabStrip<StripTab>>> & { activeKey?: string; renaming?: TabRename | null } = {}) {
  const dragged = useRef(false);
  const { activeKey = 'shell:1', ...rest } = over;
  return (
    <TabStrip
      tabs={entries}
      isActive={(tab) => `${tab.mode}:${tab.id}` === activeKey}
      splitGroups={[]}
      renaming={null}
      onRenaming={vi.fn()}
      onRename={vi.fn()}
      tabEl={vi.fn()}
      pointer={{ down: vi.fn(), move: vi.fn(), up: vi.fn(), cancel: vi.fn() }}
      justDraggedRef={dragged}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onAdd={vi.fn()}
      detail={(tab) => (tab.mode === 'browser' ? null : 'feat/tab-bar')}
      {...rest}
    />
  );
}
const seg = (key: string) => document.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)!;

describe('TabStrip', () => {
  it('tabs are segments inside one rounded container; the active one is an elevated pill', () => {
    render(<Harness />);
    const group = screen.getByTestId('tab-segments');
    // One faint container (index.css .tab-bar) and one lighter pill for the active tab (.tab-pill).
    expect(group.className).toMatch(/\btab-bar\b/);
    expect(group).toContainElement(seg('claude:1'));
    expect(seg('shell:1')).toHaveAttribute('data-active', 'true');
    expect(seg('shell:1').className).toMatch(/\btab-pill\b/);
    expect(seg('claude:1')).not.toHaveAttribute('data-active');
    expect(seg('claude:1').className).not.toMatch(/tab-pill/);
  });

  it('a thin light divider between every two tabs, the active one too', () => {
    render(<Harness activeKey="shell:1" />);
    // claude | [shell] | shell 2 | docs
    const dividers = screen.getByTestId('tab-segments').querySelectorAll('[data-testid="tab-divider"]');
    expect(dividers).toHaveLength(3);
    expect(dividers[0]!.nextElementSibling).toBe(seg('shell:1'));
    expect(dividers[0]!.className).toMatch(/\bw-px\b/);
  });

  it('each tab: its icon on a rounded tile, the title (bright when active), dim secondary text with a fade', () => {
    render(<Harness />);
    const tile = seg('claude:1').querySelector('[data-testid="tab-tile"]')!;
    expect(tile).toContainElement(screen.getByTestId('icon-claude'));
    expect(tile.className).toMatch(/\brounded-\[6px\]/);
    expect(seg('shell:1').querySelector('[data-testid="tab-title"]')!.className).toMatch(/\btext-zinc-100\b/);
    expect(seg('claude:1').querySelector('[data-testid="tab-title"]')!.className).toMatch(/\btext-zinc-400\b/);
    const detail = seg('claude:1').querySelector('[data-testid="tab-detail"]')!;
    expect(detail).toHaveTextContent('feat/tab-bar');
    expect(detail.className).toMatch(/\btruncate\b/);
    expect(detail.className).toContain('mask-image');
    // No secondary text: nothing rendered.
    expect(seg('browser:1').querySelector('[data-testid="tab-detail"]')).toBeNull();
  });

  it('about 36px tall; close × only on hover or when active; + is a quiet round button at the end', () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    expect(screen.getByTestId('tab-segments').className).toMatch(/\bh-9\b/);
    expect(screen.getByLabelText('Close Claude session').className).toMatch(/\bopacity-0\b/);
    expect(screen.getByLabelText('Close Shell session').className).not.toMatch(/\bopacity-0\b/);
    const plus = screen.getByRole('button', { name: 'New session' });
    expect(plus.className).toMatch(/\brounded-full\b/);
    expect(plus.previousElementSibling).toBe(screen.getByTestId('tab-segments'));
    fireEvent.click(plus);
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('a split group\'s members are marked, not tinted; the active member keeps the pill', () => {
    render(<Harness activeKey="shell:2" splitGroups={[{ layoutIndex: 0, keys: ['shell:1', 'shell:2'] }]} />);
    expect(seg('shell:1')).toHaveAttribute('data-in-split', 'true');
    expect(seg('shell:1')).toHaveAttribute('data-split-group', '0');
    expect(seg('shell:1').className).not.toMatch(/sky-400/);
    expect(seg('shell:2')).toHaveAttribute('data-active', 'true');
    expect(seg('shell:2').className).toMatch(/\btab-pill\b/);
  });

  it('a tab wears its agent\'s state: tinted and breathing while working or needing you (amber), red when failed; idle stays quiet', () => {
    const state: Record<string, 'working' | 'needs_you' | 'failed' | 'idle'> = { 'claude:1': 'needs_you', 'shell:1': 'working', 'shell:2': 'failed', 'browser:1': 'idle' };
    render(<Harness stateOf={(tab) => state[`${tab.mode}:${tab.id}`] ?? null} />);
    expect(seg('claude:1')).toHaveAttribute('data-agent-state', 'needs_you');
    expect(seg('claude:1').className).toMatch(/amber/);
    expect(seg('claude:1').className).toMatch(/\bpill-breathe-needs\b/);
    expect(seg('shell:1').className).toMatch(/\bpill-breathe-working\b/);
    expect(seg('shell:2').className).toMatch(/red/);
    expect(seg('shell:2').className).not.toMatch(/pill-breathe/);
    expect(seg('browser:1').className).not.toMatch(/amber|pill-breathe|red-/);
    // Never colour alone: the state is in the tab's title.
    expect(screen.getByText('Claude').closest('button')).toHaveAttribute('title', expect.stringContaining('needs you'));
  });

  describe('split groups as ONE segment (groups given)', () => {
    const groups = (over = {}) => [{ layoutIndex: 0, keys: ['shell:1', 'shell:2'], name: null, active: false, ...over }];
    it('one segment where its first member was, with stacked tiles and the members\' labels joined; the members are not drawn alone', () => {
      render(<Harness activeKey="claude:1" groups={groups()} />);
      const g = screen.getByTestId('tab-group');
      expect(g).toHaveAttribute('data-group-index', '0');
      expect(seg('shell:1')).toBeNull();
      expect(g.querySelectorAll('[data-testid="tile-layer"]')).toHaveLength(2);
      expect(g).toHaveTextContent('Shell · Shell 2');
      const order = Array.from(screen.getByTestId('tab-segments').querySelectorAll('[data-tab-key], [data-testid="tab-group"]')).map((el) => el.getAttribute('data-tab-key') ?? 'group');
      expect(order).toEqual(['claude:1', 'group', 'browser:1']);
    });
    it('at most 3 tiles; a name replaces the member labels; unnamed: the first two +N; the active layout is the pill', () => {
      const many: StripEntry<StripTab>[] = [1, 2, 3, 4, 5].map((n) => ({ tab: t('shell', String(n)), label: `Shell ${n}`, icon: <svg /> }));
      render(<Harness tabs={many} activeKey="none" groups={[{ layoutIndex: 0, keys: many.map((e) => `shell:${e.tab.id}`), name: 'Backend', active: true }]} />);
      const g = screen.getByTestId('tab-group');
      expect(g.querySelectorAll('[data-testid="tile-layer"]')).toHaveLength(3); // a deck of 3: front + 2 edges
      expect(g).toHaveTextContent('Backend');
      expect(g).not.toHaveTextContent('Shell 1');
      expect(g).toHaveAttribute('data-active', 'true');
      expect(g.className).toMatch(/\btab-pill\b/);
    });
    it('an unnamed group of 3+ is titled by its first two members and how many more', () => {
      const many: StripEntry<StripTab>[] = [1, 2, 3, 4].map((n) => ({ tab: t('shell', String(n)), label: `Shell ${n}`, icon: <svg /> }));
      render(<Harness tabs={many} activeKey="none" groups={[{ layoutIndex: 0, keys: many.map((e) => `shell:${e.tab.id}`), name: null, active: false }]} />);
      expect(screen.getByTestId('tab-group')).toHaveTextContent('Shell 1 · Shell 2 +2');
    });
    it('click shows the layout; ✕ closes the group; double-click renames it ("" clears)', () => {
      const onActivateGroup = vi.fn(); const onCloseGroup = vi.fn(); const onRenameGroup = vi.fn();
      render(<Harness groups={groups({ layoutIndex: 2 })} onActivateGroup={onActivateGroup} onCloseGroup={onCloseGroup} onRenameGroup={onRenameGroup} />);
      fireEvent.click(screen.getByText('Shell · Shell 2'));
      expect(onActivateGroup).toHaveBeenCalledWith(2);
      fireEvent.click(screen.getByRole('button', { name: 'Close group Shell · Shell 2' }));
      expect(onCloseGroup).toHaveBeenCalledWith(2);
      fireEvent.doubleClick(screen.getByText('Shell · Shell 2'));
      const box = screen.getByLabelText('Rename group');
      fireEvent.change(box, { target: { value: 'API' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onRenameGroup).toHaveBeenCalledWith(2, 'API');
      fireEvent.doubleClick(screen.getByText('Shell · Shell 2'));
      fireEvent.change(screen.getByLabelText('Rename group'), { target: { value: '  ' } });
      fireEvent.keyDown(screen.getByLabelText('Rename group'), { key: 'Enter' });
      expect(onRenameGroup).toHaveBeenLastCalledWith(2, null);
    });
    it('the group wears its loudest member\'s state', () => {
      render(<Harness groups={groups()} stateOf={(tab) => (tab.id === '2' ? 'needs_you' : 'working')} />);
      expect(screen.getByTestId('tab-group')).toHaveAttribute('data-agent-state', 'needs_you');
    });
  });

  it('keeps behaviour: click activates, double-click renames (agents/shells), the rename box commits on Enter', () => {
    const onActivate = vi.fn(); const onRenaming = vi.fn(); const onRename = vi.fn();
    const { rerender } = render(<Harness onActivate={onActivate} onRenaming={onRenaming} />);
    fireEvent.click(screen.getByText('Claude'));
    expect(onActivate).toHaveBeenCalledWith(entries[0]!.tab);
    fireEvent.doubleClick(screen.getByText('Claude'));
    expect(onRenaming).toHaveBeenCalledWith({ path: '/wt/a', mode: 'claude', id: '1', value: 'Claude' });
    fireEvent.doubleClick(screen.getByText('Docs'));
    expect(onRenaming).toHaveBeenCalledTimes(1);
    rerender(<Harness onRenaming={onRenaming} onRename={onRename} renaming={{ path: '/wt/a', mode: 'claude', id: '1', value: 'Planner' }} />);
    fireEvent.keyDown(screen.getByLabelText('Rename tab'), { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith({ path: '/wt/a', mode: 'claude', id: '1', value: 'Planner' });
  });
});
