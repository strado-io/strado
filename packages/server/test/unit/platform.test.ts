import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultShell } from '../../src/services/platform';

const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });

describe('defaultShell', () => {
  const realPlatform = process.platform;
  const realShell = process.env.SHELL;
  afterEach(() => {
    setPlatform(realPlatform);
    if (realShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = realShell;
    vi.restoreAllMocks();
  });

  it('honors $SHELL when set', () => {
    process.env.SHELL = '/usr/bin/fish';
    expect(defaultShell()).toBe('/usr/bin/fish');
  });

  it('falls back to /bin/zsh on macOS', () => {
    delete process.env.SHELL;
    setPlatform('darwin');
    expect(defaultShell()).toBe('/bin/zsh');
  });

  it('falls back to /bin/bash on Linux', () => {
    delete process.env.SHELL;
    setPlatform('linux');
    expect(defaultShell()).toBe('/bin/bash');
  });
});
