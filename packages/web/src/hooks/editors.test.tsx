import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorsAnswer } from '../types';

const editorsApi = vi.hoisted(() => ({ list: vi.fn(), setPreferred: vi.fn(), open: vi.fn() }));
vi.mock('../api', () => ({ api: { editors: editorsApi } }));

import { chosenEditor, openInEditor, OPEN_IN_EDITOR_FAILED, resetEditorsCache, setPreferredEditor, useEditors } from './editors';

const answer = (preferred: EditorsAnswer['preferred'] = null): EditorsAnswer => ({
  preferred,
  editors: [
    { id: 'vscode', label: 'VS Code', available: false, lines: false },
    { id: 'cursor', label: 'Cursor', available: true, lines: true },
    { id: 'zed', label: 'Zed', available: true, lines: true },
    { id: 'system', label: 'Default app', available: true, lines: false },
  ],
});

beforeEach(() => {
  resetEditorsCache();
  for (const f of Object.values(editorsApi)) f.mockReset();
});

describe('chosenEditor', () => {
  it('the preferred one when available; else the first available real editor; else the default app', () => {
    expect(chosenEditor(answer('zed')).id).toBe('zed');
    expect(chosenEditor(answer('vscode')).id).toBe('cursor');
    expect(chosenEditor(answer(null)).id).toBe('cursor');
    expect(chosenEditor({ preferred: null, editors: [{ id: 'system', label: 'Default app', available: true, lines: false }] }).id).toBe('system');
    expect(chosenEditor({ preferred: null, editors: [] }).id).toBe('system');
  });
});

describe('useEditors', () => {
  it('loads once for every user, and a new preference reaches all of them', async () => {
    editorsApi.list.mockResolvedValue(answer());
    const a = renderHook(() => useEditors());
    const b = renderHook(() => useEditors());
    await waitFor(() => expect(a.result.current.chosen?.label).toBe('Cursor'));
    expect(b.result.current.chosen?.label).toBe('Cursor');
    expect(editorsApi.list).toHaveBeenCalledTimes(1);
    editorsApi.setPreferred.mockResolvedValue(undefined);
    editorsApi.list.mockResolvedValue(answer('zed'));
    await act(async () => { await setPreferredEditor('zed'); });
    expect(editorsApi.setPreferred).toHaveBeenCalledWith('zed');
    expect(a.result.current.chosen?.label).toBe('Zed');
    expect(b.result.current.chosen?.label).toBe('Zed');
  });

  it('a failed list leaves no editor (callers hide the action)', async () => {
    editorsApi.list.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useEditors());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.chosen).toBeNull();
  });
});

describe('openInEditor', () => {
  it('posts the body; any failure is one fixed message', async () => {
    editorsApi.open.mockResolvedValueOnce(undefined);
    await openInEditor('ws1', { worktreePath: '/w', path: 'a.ts', line: 3 });
    expect(editorsApi.open).toHaveBeenCalledWith('ws1', { worktreePath: '/w', path: 'a.ts', line: 3 });
    editorsApi.open.mockRejectedValueOnce(new Error('spawn code ENOENT /secret/path'));
    await expect(openInEditor('ws1', { worktreePath: '/w' })).rejects.toThrow(OPEN_IN_EDITOR_FAILED);
  });
});
