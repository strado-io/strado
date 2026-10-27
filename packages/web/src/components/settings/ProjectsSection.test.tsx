import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, Worktree } from '../../types';
import { ProjectsSection, type ProjectsProps } from './ProjectsSection';

const repo = (id: string, name: string, over: Partial<RepoConfig> = {}): RepoConfig => ({
  id, name, path: `/code/${name}`, projectSubdir: null, startCommand: 'npm run dev', defaultPort: 3000,
  runCommands: [{ id: 'dev', name: 'dev', command: 'npm run dev', envFile: null }], ...over,
});
const wt = (path: string, repoId: string, branch: string) => ({ path, repoId, branch, meta: null } as unknown as Worktree);
const repos = [repo('r1', 'api'), repo('r2', 'web', { defaultPort: 5173 })];
const worktrees = [wt('/code/api', 'r1', 'main'), wt('/wt/api-fd-1', 'r1', 'fd-1'), wt('/wt/web-x', 'r2', 'x')];

function mount(over: Partial<ProjectsProps & { initial: string | null }> = {}) {
  const p = {
    repos, worktrees,
    onAdd: vi.fn(), onPatch: vi.fn().mockResolvedValue(undefined), onSaveRunCommands: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined), onDeleteWorktree: vi.fn(), ...over,
  };
  render(<ProjectsSection {...p} />);
  return p;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Settings › Projects', () => {
  it('lists every project, with Add project at the top', () => {
    const p = mount();
    const list = screen.getByRole('list', { name: 'Projects' });
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['api settings', 'web settings']);
    expect(within(list).getByRole('button', { name: 'api settings' })).toHaveTextContent('1 worktrees'); // the main checkout isn't one
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(p.onAdd).toHaveBeenCalled();
  });

  it('a project opens to its settings; a change saves through onPatch', async () => {
    const p = mount();
    fireEvent.click(screen.getByRole('button', { name: 'web settings' }));
    const page = screen.getByTestId('project-settings');
    expect(within(page).getByRole('heading', { name: 'web' })).toBeInTheDocument();
    const save = within(within(page).getByRole('region', { name: 'General' })).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(page).getByRole('textbox', { name: 'Default port' }), { target: { value: '0' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(page).getByRole('textbox', { name: 'Default port' }), { target: { value: '5180' } });
    fireEvent.change(within(page).getByRole('textbox', { name: 'Open URL (optional)' }), { target: { value: 'http://web.test' } });
    fireEvent.click(save);
    await waitFor(() => expect(p.onPatch).toHaveBeenCalledWith(repos[1], { name: 'web', defaultPort: 5180, openUrl: 'http://web.test', projectSubdir: null }));
  });

  it('its run commands are the run-command editor, saved through onSaveRunCommands', async () => {
    const p = mount({ initial: 'r1' });
    const section = screen.getByRole('region', { name: 'Run commands' });
    fireEvent.change(within(section).getByRole('textbox', { name: 'Command' }), { target: { value: 'pnpm dev' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(p.onSaveRunCommands).toHaveBeenCalledWith(repos[0], [{ id: 'dev', name: 'dev', command: 'pnpm dev', envFile: null }]));
  });

  it('lists its worktrees (not the main checkout), each with Delete', () => {
    const p = mount({ initial: 'r1' });
    const section = screen.getByRole('region', { name: 'Worktrees' });
    expect(within(section).queryByText('/code/api')).toBeNull();
    fireEvent.click(within(section).getByRole('button', { name: 'Delete fd-1' }));
    expect(p.onDeleteWorktree).toHaveBeenCalledWith(worktrees[1]);
  });

  it('Remove project asks first; confirmed, it removes and goes back to the list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const p = mount({ initial: 'r1' });
    const button = within(screen.getByRole('region', { name: 'Remove project' })).getByRole('button', { name: 'Remove project' });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remove "api" from this workspace?'));
    expect(p.onRemove).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(p.onRemove).toHaveBeenCalledWith(repos[0]));
    await screen.findByRole('list', { name: 'Projects' });
  });

  it('opens at the project it is given (the deep link), and ‹ Projects goes back', () => {
    mount({ initial: 'r2' });
    expect(within(screen.getByTestId('project-settings')).getByRole('heading', { name: 'web' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByRole('list', { name: 'Projects' })).toBeInTheDocument();
  });
});
