import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./detect.js', () => ({ detectSandboxManifest: async () => ({ node: null, summary: 'node default' }) }));
vi.mock('./image.js', () => ({ ensureBaseImage: async () => 'strado-sandbox:node' }));
vi.mock('../agentLogins/volumeWriter.js', () => ({ writeHomeVolume: vi.fn() }));

import { provisionSandbox, type ProvisionDeps } from './provision.js';
import {
  readRunnerAgentLogins,
  writeRunnerAgentLogins,
  writeRunnerClaudeToken,
} from '../agentLogins/runnerStore.js';
import { disconnectAgent } from '../connections/disconnect.js';
import { writeHomeVolume } from '../agentLogins/volumeWriter.js';
import type { StepReporter } from '../jobSteps.js';

const writeVolume = vi.mocked(writeHomeVolume);
let tmp: string;
let prevHome: string | undefined;
let created: Array<{ env: Record<string, string> }>;
let logs: string[];

function deps(): ProvisionDeps {
  return {
    sandbox: {
      status: async () => 'absent',
      create: async (c: { env: Record<string, string> }) => {
        created.push({ env: c.env });
      },
      start: async () => {},
      userArgs: () => ['--userns=keep-id'],
    } as unknown as ProvisionDeps['sandbox'],
    sandboxRuntime: { bin: 'podman' },
    sandboxSocketPath: null,
    sandboxSlugs: { set: () => {} },
    state: { patch: async () => ({}) },
    bus: { emit: () => {} },
    log: (l) => logs.push(l),
  };
}

const step = Object.assign(() => {}, { detail: () => {} }) as unknown as StepReporter;
const input = (sandboxEnv: Record<string, string> = {}) => ({
  worktreePath: '/w/one',
  projectDir: '/w/one',
  slug: 'one',
  port: null,
  cloneUrl: null,
  sandboxEnv,
  step,
});

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'provision-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
  created = [];
  logs = [];
  writeVolume.mockReset();
  writeVolume.mockResolvedValue({ claude: 'written', codex: 'skipped', opencode: 'skipped', pi: 'skipped' });
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('provisionSandbox agent logins', () => {
  it('injects runner Claude token when sandboxEnv lacks one, and trusts the worktree', async () => {
    await writeRunnerClaudeToken('sk-ant-oat01-RUNNER');
    await provisionSandbox(deps(), input({ GIT_AUTHOR_NAME: 'me' }));
    expect(created[0]!.env).toMatchObject({ GIT_AUTHOR_NAME: 'me', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-RUNNER' });
    expect(writeVolume).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'strado-sandbox:node', userArgs: ['--userns=keep-id'] }),
      { claude: { trustPaths: ['/w/one'] } },
    );
  });

  it('does not override a token already in sandboxEnv', async () => {
    await writeRunnerClaudeToken('sk-ant-oat01-RUNNER');
    await provisionSandbox(deps(), input({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-DESKTOP' }));
    expect(created[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-DESKTOP');
  });

  it('a disconnected Claude: no stored token is injected, and a desktop-sent one is dropped', async () => {
    await writeRunnerClaudeToken('sk-ant-oat01-RUNNER');
    await disconnectAgent('claude', { oneShot: null, readStore: readRunnerAgentLogins, writeStore: writeRunnerAgentLogins });
    await provisionSandbox(deps(), input());
    expect(created[0]!.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    await provisionSandbox(deps(), input({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-DESKTOP', ANTHROPIC_API_KEY: 'sk-ant-api03-KEY' }));
    expect(created[1]!.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(created[1]!.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-KEY');
  });

  it('no token anywhere → env untouched, no volume write', async () => {
    await provisionSandbox(deps(), input());
    expect(created[0]!.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(writeVolume).not.toHaveBeenCalled();
  });

  // Claude Code prefers ANTHROPIC_API_KEY when both are set, so a synced
  // subscription token next to the desktop's API key bills the API instead.
  it('a synced Claude token drops the API key, so the subscription is used', async () => {
    await writeRunnerClaudeToken('sk-ant-oat01-RUNNER');
    await provisionSandbox(deps(), input({ ANTHROPIC_API_KEY: 'sk-ant-api03-KEY' }));
    expect(created[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-RUNNER');
    expect(created[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('a desktop-sent Claude token drops the API key too', async () => {
    await provisionSandbox(deps(), input({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-DESKTOP', ANTHROPIC_API_KEY: 'sk-ant-api03-KEY' }));
    expect(created[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('no Claude token → the API key stays (it is the only way to bill)', async () => {
    await provisionSandbox(deps(), input({ ANTHROPIC_API_KEY: 'sk-ant-api03-KEY' }));
    expect(created[0]!.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-KEY');
  });

  it('re-applies the synced volume payload, adding trust for this worktree', async () => {
    await writeRunnerAgentLogins({
      claudeToken: 'sk-ant-oat01-RUNNER',
      volume: { claude: { lastOnboardingVersion: '2.0.1' }, codex: { apiKey: 'sk-codex' } },
    });
    await provisionSandbox(deps(), input());
    expect(writeVolume).toHaveBeenCalledWith(expect.anything(), {
      claude: { lastOnboardingVersion: '2.0.1', trustPaths: ['/w/one'] },
      codex: { apiKey: 'sk-codex' },
    });
  });

  it('codex key only → written without touching claude', async () => {
    await writeRunnerAgentLogins({ volume: { codex: { apiKey: 'sk-codex' } } });
    await provisionSandbox(deps(), input());
    expect(writeVolume).toHaveBeenCalledWith(expect.anything(), { codex: { apiKey: 'sk-codex' } });
  });

  it('a failed volume write never fails the create', async () => {
    await writeRunnerClaudeToken('sk-ant-oat01-RUNNER');
    writeVolume.mockRejectedValueOnce(new Error('sk-ant-oat01-RUNNER'));
    await expect(provisionSandbox(deps(), input())).resolves.toMatch(/^one-/);
    expect(logs).toContain('agent-login volume write failed');
    expect(logs.join('\n')).not.toContain('RUNNER');
  });
});
