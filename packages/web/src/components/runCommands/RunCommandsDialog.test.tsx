import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunCommandsDialog, runCommandsError } from './RunCommandsDialog';
import type { RunCommand } from '../../types';

const cmds: RunCommand[] = [{ id: 'dev', name: 'dev', command: 'pnpm dev', envFile: null }, { id: 'sb', name: 'storybook', command: 'pnpm storybook', envFile: '.env.sb' }];
const setup = (over: Partial<Parameters<typeof RunCommandsDialog>[0]> = {}) => {
  const onSave = vi.fn(async () => {});
  const onClose = vi.fn();
  render(<RunCommandsDialog repoName="Strado" commands={cmds} onSave={onSave} onClose={onClose} {...over} />);
  return { onSave, onClose };
};
const rows = () => screen.getAllByRole('group', { name: /^Run command/ });

describe('RunCommandsDialog: name, command, optional env file; add, rename, delete; pick the default', () => {
  it('lists the repo\'s commands', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Run commands — Strado' })).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    expect(within(rows()[1]!).getByLabelText('Name')).toHaveValue('storybook');
    expect(within(rows()[1]!).getByLabelText('Command')).toHaveValue('pnpm storybook');
    expect(within(rows()[1]!).getByLabelText('Env file (optional)')).toHaveValue('.env.sb');
    expect(within(rows()[0]!).getByRole('radio', { name: 'Default' })).toBeChecked();
  });

  it('rename + edit + add + delete + new default, saved as one list: the default first, ids kept, new rows without one (the server mints it)', async () => {
    const { onSave, onClose } = setup();
    fireEvent.change(within(rows()[1]!).getByLabelText('Name'), { target: { value: 'sb' } });
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Delete dev' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add run command' }));
    const added = rows()[1]!;
    fireEvent.change(within(added).getByLabelText('Name'), { target: { value: 'api' } });
    fireEvent.change(within(added).getByLabelText('Command'), { target: { value: 'pnpm api' } });
    fireEvent.click(within(added).getByRole('radio', { name: 'Default' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    const [list] = onSave.mock.calls[0] as unknown as [Partial<RunCommand>[]];
    expect(list.map((c) => [c.name, c.command, c.envFile])).toEqual([['api', 'pnpm api', null], ['sb', 'pnpm storybook', '.env.sb']]);
    expect(list[0]!.id).toBeUndefined();
    expect(list[1]!.id).toBe('sb');
    expect(onClose).toHaveBeenCalled();
  });

  it('opened to add one: starts with a fresh empty row focused', () => {
    setup({ startAdding: true });
    expect(rows()).toHaveLength(3);
    expect(within(rows()[2]!).getByLabelText('Name')).toHaveFocus();
  });

  it('needs a name and a command, and names must be unique; Save stays off until then', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Add run command' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    const r = rows()[2]!;
    fireEvent.change(within(r).getByLabelText('Name'), { target: { value: 'dev' } });
    fireEvent.change(within(r).getByLabelText('Command'), { target: { value: 'x' } });
    expect(screen.getByText('Names must be unique')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(r).getByLabelText('Name'), { target: { value: 'dev2' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('deleting the default makes the first remaining one the default', async () => {
    const { onSave } = setup();
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Delete dev' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect((onSave.mock.calls[0] as unknown as [Partial<RunCommand>[]])[0].map((c) => c.id)).toEqual(['sb']);
  });

  it('a failed save says why and stays open', async () => {
    const { onClose } = setup({ onSave: vi.fn(async () => { throw new Error('repo not found'); }) });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('repo not found');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel closes without saving', () => {
    const { onSave, onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('runCommandsError: the server\'s refusal in words', () => {
  const v = (reason: string, index?: number) => Object.assign(new Error('VALIDATION'), { details: { reason, ...(index !== undefined ? { index } : {}) } });
  it.each([
    ['name_required', 'Row 2: a name is required'],
    ['name_taken', 'Row 2: that name is taken'],
    ['command_required', 'Row 2: a command is required'],
    ['id_taken', 'Row 2: that id is taken (rename it and save again)'],
  ])('%s', (reason, text) => expect(runCommandsError(v(reason, 1))).toBe(text));
  it('anything else: the server\'s message', () => expect(runCommandsError(new Error('repo not found'))).toBe('repo not found'));
});
