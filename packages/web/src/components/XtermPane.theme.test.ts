import { afterEach, describe, expect, it } from 'vitest';
import { cardTerminalTheme } from './XtermPane';

afterEach(() => { document.documentElement.style.removeProperty('--pane-card'); });

describe('the terminal paints the pane card\'s colour', () => {
  it('background (and the cursor\'s text) take --pane-card, so card and terminal are one surface', () => {
    document.documentElement.style.setProperty('--pane-card', '16 17 20');
    expect(cardTerminalTheme({ background: '#0b0c0f', cursorAccent: '#0b0c0f', foreground: '#fff' }))
      .toEqual({ background: '#101114', cursorAccent: '#101114', foreground: '#fff' });
  });
  it('no or a malformed --pane-card: the theme as it is', () => {
    const t = { background: '#0b0c0f', foreground: '#fff' };
    expect(cardTerminalTheme(t)).toBe(t);
    document.documentElement.style.setProperty('--pane-card', 'red');
    expect(cardTerminalTheme(t)).toBe(t);
  });
});
