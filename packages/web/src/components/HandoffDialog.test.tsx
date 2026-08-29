import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HandoffDialog } from './HandoffDialog';

describe('HandoffDialog', () => {
  it('prefers another provider and submits the selected target with notes', () => {
    const onSubmit = vi.fn();
    render(
      <HandoffDialog
        source={{ mode: 'claude', sessionId: '1' }}
        opencodeInstalled
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Claude (new session)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));
    fireEvent.change(screen.getByLabelText(/Anything the next agent must know/), {
      target: { value: 'The failing test is intentional' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with OpenCode' }));
    expect(onSubmit).toHaveBeenCalledWith('opencode', 'The failing test is intentional');
  });

  it('disables OpenCode when it is not installed', () => {
    render(
      <HandoffDialog
        source={{ mode: 'codex', sessionId: '2' }}
        opencodeInstalled={false}
        busy={false}
        error={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /OpenCode/ })).toBeDisabled();
    expect(screen.getByText(/clean Codex conversation messages when available/)).toBeInTheDocument();
  });
});
