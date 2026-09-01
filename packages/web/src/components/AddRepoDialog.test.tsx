import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddRepoDialog } from './AddRepoDialog';

const detect = vi.fn();
const add = vi.fn();
const clone = vi.fn();
const create = vi.fn();
const pickDirectory = vi.fn();

vi.mock('../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ workspace: { id: 'workspace-1' } }),
}));

vi.mock('../api', () => ({
  api: {
    repos: {
      detect: (...args: unknown[]) => detect(...args),
      add: (...args: unknown[]) => add(...args),
      clone: (...args: unknown[]) => clone(...args),
      create: (...args: unknown[]) => create(...args),
    },
  },
}));

const detected = {
  id: 'rust-api',
  name: 'Rust Api',
  path: '/projects/rust-api',
  cloneUrl: null,
  projectSubdir: null,
  startCommand: 'cargo run',
  defaultPort: 8080,
  editor: 'code',
  envProfiles: [],
  warnings: ['a warning that should not block registration'],
};

beforeEach(() => {
  detect.mockReset().mockResolvedValue(detected);
  add.mockReset().mockResolvedValue(detected);
  clone.mockReset().mockResolvedValue({ repo: detected });
  create.mockReset().mockResolvedValue({ repo: detected });
  pickDirectory.mockReset().mockResolvedValue('/projects/rust-api');
  window.strado = { pickDirectory } as unknown as Window['strado'];
});

afterEach(() => {
  delete window.strado;
});

describe('AddRepoDialog', () => {
  it('starts with a compact action menu instead of the full repository form', () => {
    render(<AddRepoDialog onAdded={() => {}} onClose={() => {}} />);

    expect(screen.getByRole('menu', { name: 'Add repository' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open project' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Clone from URL' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Create new project' })).toBeInTheDocument();
    expect(screen.queryByText('Advanced settings')).not.toBeInTheDocument();
  });

  it('opens the folder picker and registers any detected Git repository', async () => {
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<AddRepoDialog onAdded={onAdded} onClose={onClose} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open project' }));

    await vi.waitFor(() => expect(detect).toHaveBeenCalledWith('workspace-1', '/projects/rust-api'));
    const { warnings: _warnings, ...repo } = detected;
    expect(add).toHaveBeenCalledWith('workspace-1', repo);
    expect(onAdded).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens a focused clone form and clones from the entered URL', async () => {
    const onClose = vi.fn();
    render(<AddRepoDialog onAdded={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Clone from URL' }));
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://github.com/owner/repo.git' },
    });
    fireEvent.change(screen.getByLabelText('Clone location'), { target: { value: '/projects' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));

    await vi.waitFor(() => {
      expect(clone).toHaveBeenCalledWith('workspace-1', 'https://github.com/owner/repo.git', '/projects');
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('creates and registers a new local Git project', async () => {
    render(<AddRepoDialog onAdded={() => {}} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Create new project' }));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'My Service' } });
    fireEvent.change(screen.getByLabelText('Parent folder'), { target: { value: '/projects' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await vi.waitFor(() => expect(create).toHaveBeenCalledWith('workspace-1', 'My Service', '/projects'));
  });
});
