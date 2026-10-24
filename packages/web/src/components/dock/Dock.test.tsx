import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dock } from './Dock';

describe('Dock', () => {
  it('location | command box, and nothing else (no station lights, no dev server)', () => {
    render(<Dock worktree={{ name: 'FD-1', branch: 'fix-login' }}>
      <input aria-label="Global search" />
    </Dock>);
    const dock = screen.getByTestId('dock');
    const where = screen.getByLabelText('Worktree: FD-1 · fix-login');
    const box = screen.getByLabelText('Global search');
    expect(dock).toContainElement(where);
    expect(where.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: /dev server/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /station|—.*(idle|working)/ })).not.toBeInTheDocument();
  });

  it('the location is a label, not a button: switching is the box\'s job', () => {
    render(<Dock worktree={{ name: 'FD-1', branch: null }}><span /></Dock>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('dock-location').tagName).toBe('SPAN');
  });

  it('names the project folder with the worktree', () => {
    render(<Dock worktree={{ repo: 'strado-public', name: 'master', branch: 'master' }}><span /></Dock>);
    expect(screen.getByLabelText('Worktree: strado-public / master')).toHaveTextContent('strado-public›master');
  });

  it('no worktree open (the board): says so', () => {
    render(<Dock worktree={null}><span /></Dock>);
    expect(screen.getByLabelText('No worktree open')).toHaveTextContent('no worktree');
  });

  it('a Focus open: Focus › repo › worktree, each with its icon and a tooltip naming what it is', () => {
    render(<Dock focus="test 2" worktree={{ repo: 'Strado Website', name: 'main', branch: 'main' }}><span /></Dock>);
    const where = screen.getByTestId('dock-location');
    expect(where).toContainElement(screen.getByTestId('dock-focus'));
    expect(where.textContent).toMatch(/^test 2›Strado Website›main/);
    expect(screen.getByTestId('dock-focus')).toHaveAttribute('title', 'Focus: test 2');
    expect(screen.getByTestId('dock-repo')).toHaveAttribute('title', 'Repository: Strado Website');
    expect(screen.getByTestId('dock-worktree')).toHaveAttribute('title', 'Worktree: main');
  });

  it('no Focus: no Focus name', () => {
    render(<Dock worktree={null}><span /></Dock>);
    expect(screen.queryByTestId('dock-focus')).not.toBeInTheDocument();
  });

  it('collapsed (Settings hid it): stays mounted, so ⌘K can still focus the box', () => {
    render(<Dock worktree={{ name: 'FD-1', branch: null }} collapsed><input aria-label="Global search" /></Dock>);
    const dock = screen.getByTestId('dock');
    expect(dock).toHaveAttribute('data-collapsed', 'true');
    expect(dock.className).toMatch(/\bh-0\b/);
    expect(dock.className).toMatch(/focus-within:h-auto/);
    expect(dock).toContainElement(screen.getByLabelText('Global search'));
  });

  it('shown by default', () => {
    render(<Dock worktree={null}><span /></Dock>);
    expect(screen.getByTestId('dock')).not.toHaveAttribute('data-collapsed');
  });
});
