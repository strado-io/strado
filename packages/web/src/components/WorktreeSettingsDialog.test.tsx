import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeSettingsDialog } from './WorktreeSettingsDialog';
import type { RepoConfig, Worktree } from '../types';

const repo = {
  id: 'r', name: 'React App', path: '/repos/react-app', defaultPort: 3000,
  startCommand: 'npm run dev -- --env {ENV_FILE}',
  envProfiles: [{ name: 'DEV', envFile: '.env.dev' }, { name: 'PROD', envFile: '.env.prod' }],
  defaultEnvProfile: 'DEV',
} as RepoConfig;

const worktree = {
  path: '/wt/FD-1', repoId: 'r', branch: 'FD-1_fix', head: 'h', prunable: false, tracked: true,
  meta: {
    repoId: 'r', ticketId: 'FD-1', title: 'Fix login', linkedFrom: null, linkedAt: null,
    port: 3101, env: { FLAG: 'on' }, lastStartedAt: null, activeEnvProfile: 'DEV',
  },
  process: { status: 'idle', pid: null, startedAt: null, port: null, detectedUrl: null, exitCode: null },
  nodeModules: { status: 'symlink', source: '/src' },
} as unknown as Worktree;

const siblings = [
  worktree,
  {
    ...worktree,
    path: '/wt/FD-7',
    meta: { ...worktree.meta!, ticketId: 'FD-7' },
    nodeModules: { status: 'directory' },
  },
] as Worktree[];

function setup(overrides: Partial<Worktree> = {}, repoOverride: RepoConfig = repo) {
  const h = {
    onSave: vi.fn().mockResolvedValue(undefined),
    onSetEnvProfile: vi.fn().mockResolvedValue(undefined),
    onLink: vi.fn(), onUnlink: vi.fn(), onRelink: vi.fn(), onAdopt: vi.fn(),
    onDelete: vi.fn(), onResetTime: vi.fn(), onClose: vi.fn(),
  };
  render(
    <WorktreeSettingsDialog
      worktree={{ ...worktree, ...overrides } as Worktree}
      repo={repoOverride}
      worktrees={siblings}
      {...h}
    />,
  );
  return h;
}

describe('WorktreeSettingsDialog', () => {
  it('saves only the changed fields', async () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText('Ticket ID'), { target: { value: 'FD-2' } });
    fireEvent.change(screen.getByLabelText('Start command override'), { target: { value: 'npm run dev:mock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.onSave).toHaveBeenCalledWith({ ticketId: 'FD-2', startCommand: 'npm run dev:mock' }));
    expect(h.onSetEnvProfile).not.toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalled();
  });

  it('closes without saving when nothing changed', async () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalled());
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it('clearing an override saves null', async () => {
    const h = setup({ meta: { ...worktree.meta!, startCommand: 'old cmd' } } as Partial<Worktree>);
    fireEvent.change(screen.getByLabelText('Start command override'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.onSave).toHaveBeenCalledWith({ startCommand: null }));
  });

  it('env profile changes go through the restart-aware route', async () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText('Env profile'), { target: { value: 'PROD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.onSetEnvProfile).toHaveBeenCalledWith('PROD'));
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it('edits the env map', async () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText('Env value 1'), { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.onSave).toHaveBeenCalledWith({ env: { FLAG: 'off' } }));
  });

  it('maintenance actions are present for a linked worktree', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink node_modules' }));
    expect(h.onUnlink).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree…' }));
    expect(h.onDelete).toHaveBeenCalled();
  });

  it('relink picks a source from the repo worktrees (no window.prompt)', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Relink…' }));
    const select = screen.getByLabelText('Link source worktree');
    // main checkout + the sibling with an installed node_modules
    expect(screen.getByText('React App (main checkout)')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: '/wt/FD-7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Relink' }));
    expect(h.onRelink).toHaveBeenCalledWith('/wt/FD-7');
  });

  it('link flow uses the same picker', () => {
    const h = setup({ nodeModules: { status: 'missing' } } as Partial<Worktree>);
    fireEvent.click(screen.getByRole('button', { name: 'Link node_modules…' }));
    fireEvent.change(screen.getByLabelText('Link source worktree'), { target: { value: '/repos/react-app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(h.onLink).toHaveBeenCalledWith('/repos/react-app');
  });

  it('untracked worktrees adopt with inline ticket/title inputs', () => {
    const h = setup({ tracked: false });
    expect(screen.queryByRole('textbox', { name: 'Ticket ID' })).not.toBeInTheDocument();
    const adopt = screen.getByRole('button', { name: 'Add worktree' });
    expect(adopt).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Adopt ticket ID'), { target: { value: 'FD-9' } });
    fireEvent.change(screen.getByLabelText('Adopt title'), { target: { value: 'legacy tree' } });
    fireEvent.click(adopt);
    expect(h.onAdopt).toHaveBeenCalledWith('FD-9', 'legacy tree');
  });

  it('validates the port instead of silently ignoring an invalid value', async () => {
    const h = setup();
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '70000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 and 65535');
    expect(h.onSave).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('does not offer node_modules maintenance for a non-Node repository', () => {
    setup(
      { nodeModules: { status: 'missing' } } as Partial<Worktree>,
      { ...repo, startCommand: 'cargo run' },
    );

    expect(screen.queryByRole('button', { name: /node_modules/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Worktree maintenance')).not.toBeInTheDocument();
  });
});
