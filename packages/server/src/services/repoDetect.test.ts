import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../shell.js';
import { detectRepo } from './repoDetect.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strado-repo-detect-'));
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('detectRepo', () => {
  it('detects a Rust project without a package.json warning', async () => {
    await fsp.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "service"\nversion = "0.1.0"\n');

    const detected = await detectRepo(root);

    expect(detected.startCommand).toBe('cargo run');
    expect(detected.warnings.join(' ')).not.toMatch(/package\.json/i);
  });

  it('accepts a language-neutral Git repository with no start command', async () => {
    await fsp.writeFile(path.join(root, 'README.md'), '# Library\n');

    const detected = await detectRepo(root);

    expect(detected.startCommand).toBe('');
    expect(detected.warnings).toEqual([]);
  });
});
