import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LspServerStatus } from '../../lib/lspAdmin';
import { LanguageServersSection } from './LanguageServersSection';

const ts: LspServerStatus = {
  id: 'typescript', lang: 'TypeScript and JavaScript', enabled: true, installed: true,
  binary: '/opt/homebrew/bin/typescript-language-server',
  install: [{ command: 'npm install -g typescript-language-server typescript', needs: 'npm', available: true }],
  running: [
    { worktreePath: '/w/a', pid: 11, rssBytes: 150 * 1024 * 1024, startedAt: '2026-10-25T10:00:00Z', lastUsedAt: '2026-10-25T10:01:00Z' },
    { worktreePath: '/w/b', pid: 12, rssBytes: null, startedAt: '2026-10-25T10:00:00Z', lastUsedAt: '2026-10-25T10:01:00Z' },
  ],
};
const go: LspServerStatus = {
  id: 'gopls', lang: 'Go', enabled: true, installed: false,
  install: [
    { command: 'go install golang.org/x/tools/gopls@latest', needs: 'go', available: false },
    { command: 'brew install gopls', os: 'darwin', needs: 'brew', available: true },
  ],
  running: [],
};
const rust: LspServerStatus = { id: 'rust-analyzer', lang: 'Rust', enabled: false, installed: true, binary: '/x/rust-analyzer', install: [], running: [] };

function client(servers: LspServerStatus[] = [ts, go, rust]) {
  return {
    list: vi.fn(async (): Promise<LspServerStatus[]> => servers),
    setEnabled: vi.fn(async (_id: string, _enabled: boolean) => {}),
    stop: vi.fn(async (_id: string) => {}),
  };
}

async function open(c: ReturnType<typeof client> = client(), install: { label: string; run: (cmd: string) => void } | null = { label: 'FD-1', run: vi.fn() }) {
  render(<LanguageServersSection client={c} install={install} />);
  await act(async () => {});
  return c;
}
const row = (lang: string) => screen.getByRole('group', { name: lang });

afterEach(() => { vi.useRealTimers(); });

describe('LanguageServersSection', () => {
  it('lists every server with its state, binary and memory', async () => {
    await open();
    expect(within(row('TypeScript and JavaScript')).getByText('Running in 2 worktrees · 150 MB')).toBeInTheDocument();
    expect(within(row('TypeScript and JavaScript')).getByText('/opt/homebrew/bin/typescript-language-server')).toBeInTheDocument();
    expect(within(row('Go')).getByText('Not installed')).toBeInTheDocument();
    expect(within(row('Rust')).getByText('Off')).toBeInTheDocument();
  });

  it('the switch turns a language on or off and reloads', async () => {
    const c = await open();
    await act(async () => { fireEvent.click(within(row('Rust')).getByRole('switch', { name: 'Use the Rust language server' })); });
    expect(c.setEnabled).toHaveBeenCalledWith('rust-analyzer', true);
    expect(c.list).toHaveBeenCalledTimes(2);
  });

  it('Stop ends the running instances; offered only while one runs', async () => {
    const c = await open();
    expect(within(row('Go')).queryByRole('button', { name: /Stop/ })).toBeNull();
    await act(async () => { fireEvent.click(within(row('TypeScript and JavaScript')).getByRole('button', { name: 'Stop TypeScript and JavaScript language server' })); });
    expect(c.stop).toHaveBeenCalledWith('typescript');
  });

  it('Install types the command into a shell in the open worktree; one whose tool is missing is disabled, with why', async () => {
    const run = vi.fn();
    await open(client(), { label: 'FD-1', run });
    const goRow = within(row('Go'));
    const missing = goRow.getByRole('button', { name: 'Install with: go install golang.org/x/tools/gopls@latest' });
    expect(missing).toBeDisabled();
    expect(goRow.getByText('Needs go')).toBeInTheDocument();
    fireEvent.click(goRow.getByRole('button', { name: 'Install with: brew install gopls' }));
    expect(run).toHaveBeenCalledWith('brew install gopls');
    expect(screen.getByText(/Install opens a shell in FD-1/)).toBeInTheDocument();
  });

  it('with no worktree open on this Mac, Install is disabled and says how', async () => {
    await open(client(), null);
    expect(within(row('Go')).getByRole('button', { name: 'Install with: brew install gopls' })).toBeDisabled();
    expect(screen.getByText(/Open a worktree on this Mac/)).toBeInTheDocument();
  });

  it('a failed load or action shows fixed words', async () => {
    const bad = client();
    bad.list.mockRejectedValueOnce(new Error('ECONNREFUSED <secret>'));
    await open(bad);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the language servers");
    expect(screen.queryByText(/secret/)).toBeNull();
  });

  it('refreshes while open (memory and running counts move)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const c = await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(c.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
