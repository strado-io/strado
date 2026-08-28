import { useEffect, useState } from 'react';

export type ThemePreset = 'true-black' | 'graphite' | 'ayu-dark' | 'dracula' | 'nord' | 'github-light';
export type UiFont = 'jetbrains' | 'inter' | 'system';
export type DiffFont = 'jetbrains' | 'system-mono';
export type TerminalFont = 'nerd' | 'jetbrains' | 'system-mono';

const PRESET_KEY = 'strado:theme-preset';
const LEGACY_THEME_KEY = 'strado:theme';
const FONT_KEY = 'strado:ui-font';
const DIFF_FONT_KEY = 'strado:diff-font';
const TERMINAL_FONT_KEY = 'strado:terminal-font';
export const APPEARANCE_CHANGE_EVENT = 'strado:appearance-change';

const isPreset = (value: string | null): value is ThemePreset =>
  value === 'true-black' || value === 'graphite' || value === 'ayu-dark' || value === 'dracula' || value === 'nord' || value === 'github-light';
const isFont = (value: string | null): value is UiFont => value === 'jetbrains' || value === 'inter' || value === 'system';
const isDiffFont = (value: string | null): value is DiffFont => value === 'jetbrains' || value === 'system-mono';
const isTerminalFont = (value: string | null): value is TerminalFont => value === 'nerd' || value === 'jetbrains' || value === 'system-mono';

export function presetMode(preset: ThemePreset): 'dark' | 'light' {
  return preset === 'github-light' ? 'light' : 'dark';
}

function storedAppearance() {
  const savedPreset = localStorage.getItem(PRESET_KEY);
  const savedFont = localStorage.getItem(FONT_KEY);
  const savedDiffFont = localStorage.getItem(DIFF_FONT_KEY);
  const savedTerminalFont = localStorage.getItem(TERMINAL_FONT_KEY);
  return {
    preset: isPreset(savedPreset)
      ? savedPreset
      : localStorage.getItem(LEGACY_THEME_KEY) === 'light' ? 'github-light' as const : 'graphite' as const,
    font: isFont(savedFont) ? savedFont : 'jetbrains' as const,
    diffFont: isDiffFont(savedDiffFont) ? savedDiffFont : 'jetbrains' as const,
    terminalFont: isTerminalFont(savedTerminalFont) ? savedTerminalFont : 'nerd' as const,
  };
}

function applyPreset(preset: ThemePreset) {
  document.documentElement.dataset.appTheme = preset;
  document.documentElement.dataset.theme = presetMode(preset);
  document.documentElement.dataset.diffTheme = 'match';
  document.documentElement.dataset.terminalTheme = 'match';
}

export function applyStoredAppearance() {
  const { preset, font, diffFont, terminalFont } = storedAppearance();
  applyPreset(preset);
  document.documentElement.dataset.uiFont = font;
  document.documentElement.dataset.diffFont = diffFont;
  document.documentElement.dataset.terminalFont = terminalFont;
}

export function useAppearance() {
  const initial = storedAppearance();
  const [preset, setPreset] = useState<ThemePreset>(initial.preset);
  const [font, setFont] = useState<UiFont>(initial.font);
  const [diffFont, setDiffFont] = useState<DiffFont>(initial.diffFont);
  const [terminalFont, setTerminalFont] = useState<TerminalFont>(initial.terminalFont);

  useEffect(() => {
    localStorage.setItem(PRESET_KEY, preset);
    localStorage.setItem(LEGACY_THEME_KEY, presetMode(preset));
    applyPreset(preset);
    window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, { detail: { preset } }));
  }, [preset]);

  useEffect(() => {
    localStorage.setItem(FONT_KEY, font);
    document.documentElement.dataset.uiFont = font;
  }, [font]);

  useEffect(() => {
    localStorage.setItem(DIFF_FONT_KEY, diffFont);
    document.documentElement.dataset.diffFont = diffFont;
  }, [diffFont]);

  useEffect(() => {
    localStorage.setItem(TERMINAL_FONT_KEY, terminalFont);
    document.documentElement.dataset.terminalFont = terminalFont;
    window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, { detail: { terminalFont } }));
  }, [terminalFont]);

  return { preset, setPreset, font, setFont, diffFont, setDiffFont, terminalFont, setTerminalFont };
}
