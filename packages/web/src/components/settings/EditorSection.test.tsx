import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorsAnswer } from '../../types';

const editorsApi = vi.hoisted(() => ({ list: vi.fn(), setPreferred: vi.fn(), open: vi.fn() }));
vi.mock('../../api', () => ({ api: { editors: editorsApi } }));

import { resetEditorsCache } from '../../hooks/editors';
import { EditorSection } from './EditorSection';

const answer = (preferred: EditorsAnswer['preferred'] = null): EditorsAnswer => ({
  preferred,
  editors: [
    { id: 'vscode', label: 'VS Code', available: false, lines: false },
    { id: 'cursor', label: 'Cursor', available: true, lines: true },
    { id: 'system', label: 'Default app', available: true, lines: false },
  ],
});

beforeEach(() => {
  resetEditorsCache();
  for (const f of Object.values(editorsApi)) f.mockReset();
});

async function open(a = answer()) {
  editorsApi.list.mockResolvedValue(a);
  render(<EditorSection />);
  await act(async () => {});
  return screen.getByRole('combobox', { name: 'Open files in' });
}

describe('EditorSection', () => {
  it('lists the editors; one not installed is disabled and says so; automatic shows what it resolves to', async () => {
    const select = await open();
    const options = [...(select as HTMLSelectElement).options].map((o) => [o.textContent, o.disabled]);
    expect(options).toEqual([
      ['Automatic (Cursor)', false],
      ['VS Code (not installed)', true],
      ['Cursor', false],
      ['Default app', false],
    ]);
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('picking one saves it; Automatic saves null', async () => {
    const select = await open();
    editorsApi.setPreferred.mockResolvedValue(undefined);
    editorsApi.list.mockResolvedValue(answer('system'));
    await act(async () => { fireEvent.change(select, { target: { value: 'system' } }); });
    expect(editorsApi.setPreferred).toHaveBeenCalledWith('system');
    expect((select as HTMLSelectElement).value).toBe('system');
    editorsApi.list.mockResolvedValue(answer());
    await act(async () => { fireEvent.change(select, { target: { value: '' } }); });
    expect(editorsApi.setPreferred).toHaveBeenLastCalledWith(null);
  });

  it('a failed save shows fixed words', async () => {
    const select = await open();
    editorsApi.setPreferred.mockRejectedValue(new Error('500 <stack>'));
    await act(async () => { fireEvent.change(select, { target: { value: 'cursor' } }); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save that — try again");
  });
});
