import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowStatusSelect } from './WorkflowStatusSelect';

describe('WorkflowStatusSelect', () => {
  it('value is empty when unset', () => {
    render(<WorkflowStatusSelect value={null} onChange={vi.fn()} />);
    expect((screen.getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('');
  });

  it('reflects the current status and renders its label', () => {
    render(<WorkflowStatusSelect value="ready_for_qa" onChange={vi.fn()} />);
    expect((screen.getByLabelText('Workflow status') as HTMLSelectElement).value).toBe('ready_for_qa');
    expect(screen.getByRole('option', { name: 'READY FOR QA' })).toBeInTheDocument();
  });

  it('calls onChange with the chosen slug', () => {
    const onChange = vi.fn();
    render(<WorkflowStatusSelect value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Workflow status'), { target: { value: 'in_progress' } });
    expect(onChange).toHaveBeenCalledWith('in_progress');
  });

  it('calls onChange with null when choosing None', () => {
    const onChange = vi.fn();
    render(<WorkflowStatusSelect value="done" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Workflow status'), { target: { value: '__none__' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
