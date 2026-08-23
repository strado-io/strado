import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoteDialog } from './NoteDialog';
import type { Worktree } from '../types';

function wt(note: string | null): Worktree {
  return {
    path: '/repo/FD-1', repoId: 'r', branch: 'b', head: 'h', prunable: false, tracked: true,
    meta: { repoId: 'r', ticketId: 'FD-1', title: 'T', linkedFrom: null, linkedAt: null, port: null, env: {}, lastStartedAt: null, note },
    process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  } as Worktree;
}

describe('NoteDialog', () => {
  it('prefills the textarea with the existing note', () => {
    render(<NoteDialog worktree={wt('fix the bug')} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('fix the bug');
  });

  it('Save calls onSave with the edited text', () => {
    const onSave = vi.fn();
    render(<NoteDialog worktree={wt('')} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'new note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('new note');
  });

  it('Cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(<NoteDialog worktree={wt('x')} onSave={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('passes the raw (untrimmed) text to onSave so the caller decides null-mapping', () => {
    const onSave = vi.fn();
    render(<NoteDialog worktree={wt('something')} onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('   ');
  });
});
