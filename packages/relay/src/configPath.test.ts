import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runnerConfigPath } from './configPath.js';

const HOME = '/Users/test';

describe('runnerConfigPath', () => {
  it('defaults to ~/.strado/runner.json', () => {
    expect(runnerConfigPath({}, HOME)).toBe(path.join(HOME, '.strado', 'runner.json'));
  });

  it('follows STRADO_HOME so the dev profile gets its own identity', () => {
    expect(runnerConfigPath({ STRADO_HOME: path.join(HOME, '.strado-dev') }, HOME)).toBe(
      path.join(HOME, '.strado-dev', 'runner.json'),
    );
  });

  it('ignores an empty STRADO_HOME', () => {
    expect(runnerConfigPath({ STRADO_HOME: '' }, HOME)).toBe(
      path.join(HOME, '.strado', 'runner.json'),
    );
  });
});
