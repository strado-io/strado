import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevServerButton } from './DevServerButton';

type Extra = { port?: number | null; error?: string | null; remote?: boolean; detail?: string; profiles?: { names: string[]; current: string } };
const setup = (status: string, extra: Extra = {}) => {
  const on = { start: vi.fn(), stop: vi.fn(), logs: vi.fn(), profile: vi.fn() };
  render(<DevServerButton status={status as never} port={extra.port ?? null} error={extra.error ?? null} remote={extra.remote}
    detail={extra.detail ?? ''} profiles={extra.profiles ?? null}
    onStart={on.start} onStop={on.stop} onLogs={on.logs} onProfile={on.profile} />);
  return on;
};
const openMenu = () => { fireEvent.click(screen.getByRole('button', { name: 'Dev server menu' })); return screen.getByRole('menu', { name: 'Dev server' }); };

afterEach(() => { vi.restoreAllMocks(); });

describe('DevServerButton (▶ dev)', () => {
  it('idle: one click starts it', () => {
    const on = setup('idle');
    fireEvent.click(screen.getByRole('button', { name: 'Start dev server' }));
    expect(on.start).toHaveBeenCalled();
  });

  it('running: shows the port; one click stops it', () => {
    const on = setup('running', { port: 5173 });
    const b = screen.getByRole('button', { name: 'Stop dev server' });
    expect(b).toHaveTextContent(':5173');
    fireEvent.click(b);
    expect(on.stop).toHaveBeenCalled();
  });

  it('starting says so and takes no second click', () => {
    setup('starting');
    expect(screen.getByRole('button', { name: 'Stop dev server' })).toHaveTextContent('Starting…');
  });

  it('a start the server refused is shown, not swallowed', () => {
    setup('idle', { error: 'No dev script in package.json' });
    expect(screen.getByRole('alert')).toHaveTextContent('No dev script in package.json');
  });

  it('the menu: what it is doing (where it serves), start/stop, logs', () => {
    const on = setup('crashed', { detail: 'exit code 1' });
    const menu = openMenu();
    expect(menu).toHaveTextContent('exit code 1');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Logs' }));
    expect(on.logs).toHaveBeenCalled();
  });

  it('a remote worktree: the port-forward detail, start/stop, and no local logs', () => {
    const on = setup('running', { remote: true, port: 3000, detail: 'localhost:3101 → runner-1:3000' });
    const menu = openMenu();
    expect(menu).toHaveTextContent('localhost:3101 → runner-1:3000');
    expect(within(menu).queryByRole('menuitem', { name: 'Logs' })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stop' }));
    expect(on.stop).toHaveBeenCalled();
  });

  it('the env profile lives in the menu; switching while it runs asks first', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const on = setup('running', { profiles: { names: ['default', 'staging'], current: 'default' } });
    const menu = openMenu();
    const select = within(menu).getByLabelText('Env profile');
    expect(select).toHaveValue('default');
    fireEvent.change(select, { target: { value: 'staging' } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(on.profile).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'staging' } });
    expect(on.profile).toHaveBeenCalledWith('staging');
  });

  it('idle: switching the profile needs no confirm; no profiles, no select', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const on = setup('idle', { profiles: { names: ['default', 'staging'], current: 'default' } });
    fireEvent.change(within(openMenu()).getByLabelText('Env profile'), { target: { value: 'staging' } });
    expect(confirm).not.toHaveBeenCalled();
    expect(on.profile).toHaveBeenCalledWith('staging');
  });
});
