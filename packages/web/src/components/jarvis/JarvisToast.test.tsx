import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const undoMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../lib/jarvis/execute', () => ({ runUndo: undoMock }));
vi.mock('../../lib/jarvis/serverPort', () => ({ jarvisServerPort: () => 'SERVER' }));
vi.mock('../../lib/jarvis/parse', () => ({ parse: vi.fn() }));
const hubSnap = vi.hoisted(() => ({ value: 'AFTER' as unknown }));
vi.mock('../../contexts/UiControlContext', () => ({ useUiHub: () => () => ({ jarvis: { snapshot: () => hubSnap.value } }) }));
vi.mock('../../contexts/IntercomContext', () => ({ useIntercom: () => ({ peers: [] }) }));

import { JarvisToast } from './JarvisPaletteHost';

const run = { ok: true, summary: 'Open shell right', undo: [{ kind: 'restore' as const, path: '/w/a', snapshot: 'S' }], undoable: true };

beforeEach(() => { undoMock.mockClear(); hubSnap.value = 'AFTER'; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('JarvisToast', () => {
  it('a successful run shows no toast (the result is on screen), yet ⌘Z right after still undoes it', () => {
    render(<JarvisToast wsId="ws1" run={run} onDone={vi.fn()} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(undoMock).toHaveBeenCalledWith(run.undo, { hub: expect.anything(), server: 'SERVER' }, { restoreLayout: true });
  });
  it('a queued message is news the screen does not show: it gets a toast', () => {
    render(<JarvisToast wsId="ws1" run={{ ...run, undo: [], undoable: false, notice: true, summary: 'claude-1 is busy — queued, it’ll read it after this turn' }} onDone={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('claude-1 is busy — queued');
  });
  it('an agent\'s answer with Show: the button runs it and closes the toast', () => {
    const onDone = vi.fn();
    const show = vi.fn();
    render(<JarvisToast wsId="ws1" run={{ ...run, undo: [], undoable: false, notice: true, summary: 'claude-1: Yes, all 40 pass.', action: { label: 'Show', run: show } }} onDone={onDone} />);
    expect(screen.getByRole('status')).toHaveTextContent('claude-1: Yes, all 40 pass.');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(show).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
  it('a failure says what happened; Undo runs the plan\'s undo against the hub and server, then closes', () => {
    const onDone = vi.fn();
    render(<JarvisToast wsId="ws1" run={{ ...run, ok: false }} onDone={onDone} />);
    expect(screen.getByText('Partly done: Open shell right')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(undoMock).toHaveBeenCalledWith(run.undo, { hub: expect.anything(), server: 'SERVER' }, { restoreLayout: true });
    expect(onDone).toHaveBeenCalled();
  });
  it('if the user changed the layout after the run, undo leaves their layout alone', () => {
    render(<JarvisToast wsId="ws1" run={run} onDone={vi.fn()} />);
    hubSnap.value = 'USER MOVED THINGS';
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(undoMock).toHaveBeenCalledWith(run.undo, expect.anything(), { restoreLayout: false });
  });
  it('⌘Z undoes unless a text field has focus', () => {
    const onDone = vi.fn();
    render(<><input aria-label="typing" /><JarvisToast wsId="ws1" run={run} onDone={onDone} /></>);
    screen.getByLabelText('typing').focus();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(undoMock).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(undoMock).toHaveBeenCalledTimes(1);
  });
  it('goes away on its own; nothing to undo means no Undo button', () => {
    const onDone = vi.fn();
    render(<JarvisToast wsId="ws1" run={{ ...run, ok: false, undo: [], undoable: false }} onDone={onDone} />);
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(8_000); });
    expect(onDone).toHaveBeenCalled();
  });
  it('a partial failure says so', () => {
    render(<JarvisToast wsId="ws1" run={{ ...run, ok: false }} onDone={vi.fn()} />);
    expect(screen.getByText('Partly done: Open shell right')).toBeInTheDocument();
  });
});
