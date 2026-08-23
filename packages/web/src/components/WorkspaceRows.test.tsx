import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRows } from './WorkspaceRows';
import type { Workspace } from '../types';

const ws = (id: string): Workspace => ({
  id, name: id.toUpperCase(), color: '#334455', icon: id[0]!,
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
});
const list = [ws('a'), ws('b'), ws('c')];

const ROW_H = 40;
const TOP = 100;

// jsdom has no layout: every rect is zero. Give each row the geometry its
// data-index implies, which is what the drag measures.
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

function renderRows(onReorder = vi.fn(), workspaces = list, disabled = false) {
  render(
    <table>
      <WorkspaceRows
        workspaces={workspaces}
        activeId="a"
        onReorder={onReorder}
        onDelete={vi.fn()}
        disabled={disabled}
      />
    </table>,
  );
  return onReorder;
}

/** Grab a row by its handle and drop it at clientY. */
function dragRow(name: string, toY: number) {
  const handle = screen.getByRole('button', { name: `Reorder ${name}` });
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: TOP + ROW_H / 2 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: toY });
  fireEvent.pointerUp(handle, { pointerId: 1, clientY: toY });
}

describe('WorkspaceRows', () => {
  it('lists every workspace with its id and the active marker', () => {
    renderRows();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('reports the new order when a row is dragged down', () => {
    const onReorder = renderRows();
    dragRow('A', TOP + 2 * ROW_H + 30); // past row 2's midline
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('reports the new order when a row is dragged up', () => {
    const onReorder = renderRows();
    dragRow('C', TOP + 5); // above row 0's midline
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });

  it('says nothing when the row is dropped where it started', () => {
    const onReorder = renderRows();
    dragRow('B', TOP + ROW_H + 10);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('abandons the drag on Escape', () => {
    const onReorder = renderRows();
    const handle = screen.getByRole('button', { name: 'Reorder A' });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: TOP + 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: TOP + 2 * ROW_H + 30 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: TOP + 2 * ROW_H + 30 });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('offers no handle when there is nothing to reorder', () => {
    renderRows(vi.fn(), [ws('a')]);
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull();
  });

  it('does not start a drag when disabled', () => {
    const onReorder = renderRows(vi.fn(), list, true);
    dragRow('A', TOP + 2 * ROW_H + 30);
    expect(onReorder).not.toHaveBeenCalled();
  });
});
