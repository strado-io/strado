import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EscalationBanner } from './EscalationBanner';

describe('EscalationBanner', () => {
  it('names the escalation and hands its id to onAnswer', async () => {
    const onAnswer = vi.fn();
    render(<EscalationBanner escalation={{ id: 'E1', title: 'db?' } as never} onAnswer={onAnswer} />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting on you: db?');
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(onAnswer).toHaveBeenCalledWith('E1');
  });
});
