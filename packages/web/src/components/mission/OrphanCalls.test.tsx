import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrphanCalls } from './OrphanCalls';

const orphan = (over = {}) => ({ id: 'O1', from: 'claude-9@repo', name: 'claude-9', title: 'ship it?', body: 'all green', createdAt: 1, ...over });

describe('OrphanCalls: a call whose asker has no tab any more', () => {
  it('nothing open: renders nothing', () => {
    const { container } = render(<OrphanCalls calls={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('one muted line per call: who asked, that its tab closed, the question (body in the title)', () => {
    render(<OrphanCalls calls={[orphan(), orphan({ id: 'O2', name: 'codex-1', title: 'which port?' })]} onDismiss={vi.fn()} />);
    const rows = screen.getAllByTestId('orphan-call');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('claude-9 · tab closed · asked: ship it?');
    expect(rows[0]!.querySelector('[title]')).toHaveAttribute('title', 'ship it?\nall green');
  });

  it('Dismiss clears it by id and hides it at once; a failure says so and keeps it', async () => {
    const onDismiss = vi.fn(async () => {});
    const { rerender } = render(<OrphanCalls calls={[orphan()]} onDismiss={onDismiss} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude-9’s call' })); });
    expect(onDismiss).toHaveBeenCalledWith('O1');
    expect(screen.queryByTestId('orphan-call')).not.toBeInTheDocument();
    const failing = vi.fn(async () => { throw new Error('already dismissed'); });
    rerender(<OrphanCalls calls={[orphan({ id: 'O3' })]} onDismiss={failing} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude-9’s call' })); });
    expect(screen.getByTestId('orphan-call')).toHaveTextContent("Couldn't dismiss: already dismissed");
  });
});
