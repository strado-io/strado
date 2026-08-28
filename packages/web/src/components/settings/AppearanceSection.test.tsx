import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppearanceSection } from './AppearanceSection';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.appTheme;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.uiFont;
  delete document.documentElement.dataset.diffTheme;
  delete document.documentElement.dataset.diffFont;
  delete document.documentElement.dataset.terminalTheme;
  delete document.documentElement.dataset.terminalFont;
});

describe('AppearanceSection', () => {
  it('applies a coordinated preset to the app, diff, and terminal', () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'GitHub Light' }));
    expect(localStorage.getItem('strado:theme-preset')).toBe('github-light');
    expect(localStorage.getItem('strado:theme')).toBe('light');
    expect(document.documentElement.dataset.appTheme).toBe('github-light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.diffTheme).toBe('match');
    expect(document.documentElement.dataset.terminalTheme).toBe('match');
  });

  it('changes the UI font and applies it globally', () => {
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText('UI font'), { target: { value: 'inter' } });
    expect(localStorage.getItem('strado:ui-font')).toBe('inter');
    expect(document.documentElement.dataset.uiFont).toBe('inter');
  });

  it('offers and applies the True Black preset', () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'True Black' }));
    expect(localStorage.getItem('strado:theme-preset')).toBe('true-black');
    expect(document.documentElement.dataset.appTheme).toBe('true-black');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies the dedicated diff font preference', () => {
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText('Diff font'), { target: { value: 'system-mono' } });
    expect(localStorage.getItem('strado:diff-font')).toBe('system-mono');
    expect(document.documentElement.dataset.diffFont).toBe('system-mono');
  });

  it('applies the dedicated terminal font preference', () => {
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText('Terminal font'), { target: { value: 'jetbrains' } });
    expect(localStorage.getItem('strado:terminal-font')).toBe('jetbrains');
    expect(document.documentElement.dataset.terminalFont).toBe('jetbrains');
  });

  it('persists independent hub time and status visibility toggles', () => {
    render(<AppearanceSection />);
    const time = screen.getByRole('switch', { name: 'Show elapsed time' });
    const status = screen.getByRole('switch', { name: 'Show status' });
    expect(time).toHaveAttribute('aria-checked', 'true');
    expect(status).toHaveAttribute('aria-checked', 'true');
    expect(time.firstElementChild).toHaveClass('left-0.5', 'translate-x-4');

    fireEvent.click(time);
    fireEvent.click(status);

    expect(time).toHaveAttribute('aria-checked', 'false');
    expect(status).toHaveAttribute('aria-checked', 'false');
    expect(time.firstElementChild).toHaveClass('left-0.5', 'translate-x-0');
    expect(localStorage.getItem('strado:hub-show-time')).toBe('false');
    expect(localStorage.getItem('strado:hub-show-status')).toBe('false');
  });
});
