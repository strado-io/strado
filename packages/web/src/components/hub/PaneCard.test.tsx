import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneCard } from './PaneCard';
import { PaneLayout } from './PaneLayout';

const card = (over: Partial<React.ComponentProps<typeof PaneCard>> = {}) => {
  const props = {
    paneKey: 'shell:1', title: 'Shell', icon: <span data-testid="tab-icon" />, subtitle: 'FD-1',
    focused: false, docked: true, hostRef: vi.fn(), bodyRef: vi.fn(), onActivate: vi.fn(),
    onSplitRight: vi.fn(), onSplitDown: vi.fn(), onFullTab: vi.fn(), onClose: vi.fn(), ...over,
  };
  render(<PaneCard {...props} />);
  return props;
};

describe('PaneCard: one pane as its own card', () => {
  it('a card with a header inside: the tab\'s icon, its title bold, the branch dim', () => {
    card();
    const host = screen.getByTestId('pane-host');
    expect(host).toHaveAttribute('data-pane-key', 'shell:1');
    expect(host.className).toMatch(/\bpane-card\b/);
    expect(host.className).toMatch(/\bglass\b/);
    const header = screen.getByTestId('pane-header');
    expect(host).toContainElement(header);
    expect(header).toContainElement(screen.getByTestId('tab-icon'));
    expect(screen.getByText('Shell').className).toMatch(/\bfont-semibold\b/);
    expect(screen.getByText('FD-1').className).toMatch(/text-zinc-500/);
  });

  it('the focused pane in a split is marked (the brighter border); a lone card or an unfocused one is not', () => {
    card({ focused: true });
    expect(screen.getByTestId('pane-host')).toHaveAttribute('data-focused', 'true');
  });
  it.each([[{ focused: false }], [{ focused: true, docked: false }]])('not marked: %o', (over) => {
    card(over);
    expect(screen.getByTestId('pane-host')).not.toHaveAttribute('data-focused');
  });

  it('quiet header buttons: split right, split down, full tab, close', () => {
    const p = card();
    fireEvent.click(screen.getByRole('button', { name: 'Split Shell right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Split Shell down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Shell as full tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Shell' }));
    expect(p.onSplitRight).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Split Shell right' }));
    expect(p.onSplitDown).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Split Shell down' }));
    expect(p.onFullTab).toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalled();
  });

  it('a button with no handler is not drawn (a lone tab has no full-tab; a browser cannot split)', () => {
    card({ onFullTab: undefined, onSplitRight: undefined, onSplitDown: undefined });
    expect(screen.queryByRole('button', { name: /full tab/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Split/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Shell' })).toBeInTheDocument();
  });

  it('a press on the header focuses the pane; a press on a button does not', () => {
    const p = card();
    fireEvent.pointerDown(screen.getByText('Shell'));
    expect(p.onActivate).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close Shell' }));
    expect(p.onActivate).toHaveBeenCalledTimes(1);
  });

  it('the body is a separate element under the header: the live surface is placed over it', () => {
    const p = card();
    const body = screen.getByTestId('pane-body');
    expect(screen.getByTestId('pane-host')).toContainElement(body);
    expect(p.bodyRef).toHaveBeenCalledWith(body);
    expect(p.hostRef).toHaveBeenCalledWith(screen.getByTestId('pane-host'));
  });
});

describe('PaneCard: header buttons', () => {
  it('a float: zoom and float sit together, float lit; minimize and close sit together', () => {
    card({ onZoom: vi.fn(), onDock: vi.fn(), floating: true, onMinimize: vi.fn(), onClose: vi.fn() });
    const zoom = screen.getByRole('button', { name: 'Zoom Shell' });
    const dock = screen.getByRole('button', { name: 'Dock Shell' });
    expect(dock).toHaveAttribute('aria-pressed', 'true');
    expect(zoom.parentElement).toBe(dock.parentElement);
    expect(screen.getByRole('button', { name: 'Minimize Shell' }).parentElement)
      .toBe(screen.getByRole('button', { name: 'Close Shell' }).parentElement);
  });

  it('zoomed: only the lit way back out and close', () => {
    card({ onZoom: vi.fn(), zoomed: true, onSplitRight: vi.fn(), onFullTab: vi.fn(), onMinimize: vi.fn(), onClose: vi.fn() });
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Unzoom Shell', 'Close Shell']);
    expect(screen.getByRole('button', { name: 'Unzoom Shell' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('nothing is lit while docked and unzoomed', () => {
    card({ onZoom: vi.fn(), onFloat: vi.fn() });
    expect(screen.getByRole('button', { name: 'Zoom Shell' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Float Shell' })).not.toHaveAttribute('aria-pressed', 'true');
  });
});

describe('PaneLayout: cards with gaps, the resize handle lives in the gap', () => {
  it('a split draws both leaves and a handle that is invisible until hover', () => {
    const onDividerPointerDown = vi.fn();
    render(
      <PaneLayout
        node={{ kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'leaf', key: 'a' }, b: { kind: 'leaf', key: 'b' } }}
        renderLeaf={(k) => <div data-testid={`leaf-${k}`} />}
        onDividerPointerDown={onDividerPointerDown}
      />,
    );
    expect(screen.getByTestId('leaf-a')).toBeInTheDocument();
    expect(screen.getByTestId('leaf-b')).toBeInTheDocument();
    const handle = screen.getByRole('separator', { name: 'Resize panes' });
    expect(handle.className).toMatch(/\bw-2\b/);
    expect(handle.className).not.toMatch(/\bbg-zinc/);
    const line = handle.firstElementChild!;
    expect(line.className).toMatch(/bg-transparent/);
    expect(line.className).toMatch(/group-hover\/sep:bg-/);
    fireEvent.pointerDown(handle);
    expect(onDividerPointerDown).toHaveBeenCalledWith(expect.anything(), [], 'row');
  });
});
