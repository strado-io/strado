import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackDialog } from './FeedbackDialog';
import { api } from '../api';

afterEach(() => { vi.restoreAllMocks(); });

describe('FeedbackDialog', () => {
  it('disables Send until a message is typed', () => {
    render(<FeedbackDialog open onClose={() => {}} />);
    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'hello' } });
    expect(send).toBeEnabled();
  });

  it('shows the diagnostics toggle only for Bug', () => {
    render(<FeedbackDialog open onClose={() => {}} />);
    expect(screen.getByLabelText(/include diagnostics/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^idea$/i }));
    expect(screen.queryByLabelText(/include diagnostics/i)).not.toBeInTheDocument();
  });

  it('submits and calls onClose on success', async () => {
    const submit = vi.spyOn(api.feedback, 'submit').mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(<FeedbackDialog open onClose={onClose} context="tasks" />);
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'it broke' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'bug', message: 'it broke', includeDiagnostics: true, context: 'tasks' }),
    ));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an error with Retry on failure', async () => {
    vi.spyOn(api.feedback, 'submit').mockRejectedValue(new Error('down'));
    render(<FeedbackDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/couldn't send/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('resets fields when reopened', () => {
    const { rerender } = render(<FeedbackDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'draft text' } });
    rerender(<FeedbackDialog open={false} onClose={() => {}} />);
    rerender(<FeedbackDialog open onClose={() => {}} />);
    expect(screen.getByLabelText(/message/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });
});
