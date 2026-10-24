import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { toResponse, AppError } from '../errors.js';
import { registerAgentLoginsRunnerRoutes } from './agentLoginsRunner.js';
import { sealBundle, generateBoxKey, generateSenderKey, signSealed, fingerprintOf } from '../services/agentLogins/seal.js';
import { readRunnerAgentLogins, readRunnerClaudeToken, writeRunnerAgentLogins } from '../services/agentLogins/runnerStore.js';
import { AGENT_LOGIN_PATHS, type AgentLoginBundle, type BoxKeyInfo } from '../services/agentLogins/types.js';
import type { writeHomeVolume } from '../services/agentLogins/volumeWriter.js';

let tmp: string;
let prevHome: string | undefined;
let app: FastifyInstance;
type WriteVolume = typeof writeHomeVolume;
let writeVolume: Mock<Parameters<WriteVolume>, ReturnType<WriteVolume>>;
let findImage: Mock<[], Promise<string | null>>;
let logs: string[];

let sender = generateSenderKey();
let clock = 1_700_000_000_000;
/** Signed by `sender`, with a fresh, increasing issuedAt unless one is given. */
function seal(b: Omit<AgentLoginBundle, 'issuedAt'>, publicKey: string, key = sender, issuedAt = ++clock) {
  return sealBundle({ issuedAt, ...b }, publicKey, key.privateKey);
}

const bundle: Omit<AgentLoginBundle, 'issuedAt'> = {
  claude: { token: 'sk-ant-oat01-CLAUDESECRET', lastOnboardingVersion: '2.0.1' },
  codex: { apiKey: 'sk-CODEXSECRET' },
};

async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  a.setErrorHandler((err, _req, reply) => {
    reply.code(err instanceof AppError ? err.httpStatus : 500).send(toResponse(err));
  });
  await registerAgentLoginsRunnerRoutes(a, {
    sandbox: { ensureHomeVolume: async () => {}, userArgs: () => ['--userns=keep-id'] },
    sandboxRuntime: { bin: 'podman' },
    findImage,
    writeVolume,
    log: (l) => logs.push(l),
  });
  return a;
}

async function boxKey(): Promise<BoxKeyInfo> {
  return (await app.inject({ method: 'GET', url: AGENT_LOGIN_PATHS.boxKey })).json();
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-logins-runner-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
  logs = [];
  sender = generateSenderKey();
  findImage = vi.fn<[], Promise<string | null>>(async () => 'localhost/strado-sandbox:base-v4');
  writeVolume = vi.fn<Parameters<WriteVolume>, ReturnType<WriteVolume>>(async (_d, p) => ({
    claude: p.claude ? 'written' : 'skipped',
    codex: p.codex ? 'written' : 'skipped',
    opencode: p.opencode ? 'written' : 'skipped',
    pi: p.pi ? 'written' : 'skipped',
  }));
  app = await build();
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runner agent-login routes', () => {
  it('box-key returns stable fingerprint across calls and restarts', async () => {
    const a = await boxKey();
    expect(a.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(await boxKey()).toEqual(a);
    const stat = await fs.stat(path.join(tmp, 'runner-box.key'));
    expect(stat.mode & 0o777).toBe(0o600);
    const body = JSON.stringify(a);
    expect(body).not.toContain('privateKey');
  });

  it('opens a sealed bundle, stores the Claude token, writes the rest to the volume', async () => {
    const { publicKey, fingerprint } = await boxKey();
    const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fingerprint, agents: { claude: 'written', codex: 'written', opencode: 'skipped', pi: 'skipped' } });
    expect(await readRunnerClaudeToken()).toBe('sk-ant-oat01-CLAUDESECRET');
    const [deps, payload] = writeVolume.mock.calls[0]!;
    expect(deps).toMatchObject({ image: 'localhost/strado-sandbox:base-v4', userArgs: ['--userns=keep-id'] });
    // The token stays out of the volume.
    expect(JSON.stringify(payload)).not.toContain('CLAUDESECRET');
    expect(payload).toEqual({ claude: { lastOnboardingVersion: '2.0.1' }, codex: { apiKey: 'sk-CODEXSECRET' } });

    writeVolume.mockResolvedValueOnce({ claude: 'unchanged', codex: 'unchanged', opencode: 'skipped', pi: 'skipped' });
    const again = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    expect(again.json().agents.claude).toBe('unchanged');
  });

  it('tampered body → 400 fixed message, writer never called', async () => {
    const { publicKey } = await boxKey();
    const sealed = seal(bundle, publicKey);
    const ct = Buffer.from(sealed.ct, 'base64');
    ct[0]! ^= 1;
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: { ...sealed, ct: ct.toString('base64') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('sealed bundle rejected');
    expect(res.json().error.details).toBeUndefined();
    expect(writeVolume).not.toHaveBeenCalled();
    expect(await readRunnerClaudeToken()).toBeNull();
  });

  it('a bundle sealed to another key is rejected', async () => {
    await boxKey();
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal(bundle, generateBoxKey().publicKey),
    });
    expect(res.statusCode).toBe(400);
    expect(writeVolume).not.toHaveBeenCalled();
  });

  it('a malformed body is rejected without echoing it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: { v: 1, epk: 'sk-PLAINSECRET!', iv: '', ct: '', tag: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('PLAINSECRET');
    expect(res.json().error).toEqual({ code: 'VALIDATION', message: 'sealed bundle rejected' });
  });

  it('stores everything before container work; a fresh runner with no image writes no volume', async () => {
    findImage.mockResolvedValueOnce(null);
    const { publicKey } = await boxKey();
    const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual({ claude: 'written', codex: 'pending', opencode: 'skipped', pi: 'skipped' });
    expect(writeVolume).not.toHaveBeenCalled();
    expect(await readRunnerAgentLogins()).toMatchObject({
      claudeToken: 'sk-ant-oat01-CLAUDESECRET',
      volume: { claude: { lastOnboardingVersion: '2.0.1' }, codex: { apiKey: 'sk-CODEXSECRET' } },
    });
    expect((await fs.stat(path.join(tmp, 'agent-logins-runner.json'))).mode & 0o777).toBe(0o600);
  });

  it('a later sync keeps agents it does not carry', async () => {
    const { publicKey } = await boxKey();
    await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ opencode: { providers: { openai: { type: 'api', key: 'k' } } } }, publicKey),
    });
    expect(res.json().agents).toEqual({ claude: 'skipped', codex: 'skipped', opencode: 'written', pi: 'skipped' });
    const stored = await readRunnerAgentLogins();
    expect(stored.claudeToken).toBe('sk-ant-oat01-CLAUDESECRET');
    expect(stored.volume?.codex).toEqual({ apiKey: 'sk-CODEXSECRET' });
  });

  it('pi and static oauth entries are stored with only their login fields', async () => {
    const { publicKey } = await boxKey();
    const or = { type: 'oauth' as const, access: 'sk-or-SECRET', refresh: '' as const, expires: 9 };
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal(
        {
          pi: { providers: { openrouter: { ...or, extra: 'x' } as typeof or } },
          opencode: { providers: { openrouter: or } },
        },
        publicKey,
      ),
    });
    expect(res.json().agents).toEqual({ claude: 'skipped', codex: 'skipped', opencode: 'written', pi: 'written' });
    const stored = await readRunnerAgentLogins();
    expect(stored.volume?.pi).toEqual({ providers: { openrouter: or } });
    expect(stored.volume?.opencode).toEqual({ providers: { openrouter: or } });
    expect(writeVolume.mock.calls[0]![1].pi).toEqual({ providers: { openrouter: or }, prev: {} });
  });

  it('a re-sync hands the writer what was sent before', async () => {
    const { publicKey } = await boxKey();
    const a = { type: 'api' as const, key: 'k-a' };
    const b = { type: 'api' as const, key: 'k-b' };
    await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal({ pi: { providers: { a, b } } }, publicKey) });
    expect(writeVolume.mock.calls[0]![1].pi).toEqual({ providers: { a, b }, prev: {} });
    await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal({ pi: { providers: { a } } }, publicKey) });
    expect(writeVolume.mock.calls[1]![1].pi).toEqual({ providers: { a }, prev: { a, b } });
    expect((await readRunnerAgentLogins()).volume?.pi).toEqual({ providers: { a } });
  });

  it('a disconnected agent is skipped by a sync: neither stored nor written', async () => {
    const { publicKey } = await boxKey();
    await writeRunnerAgentLogins({ disconnected: ['claude', 'codex'] });
    const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    expect(res.json().agents).toEqual({ claude: 'skipped', codex: 'skipped', opencode: 'skipped', pi: 'skipped' });
    const stored = await readRunnerAgentLogins();
    expect(stored.claudeToken).toBeUndefined();
    expect(stored.volume?.codex).toBeUndefined();
    expect(stored.disconnected).toEqual(['claude', 'codex']);
    expect(writeVolume).not.toHaveBeenCalled();
  });

  it('an explicit Connect of one agent brings only that agent back', async () => {
    const { publicKey } = await boxKey();
    await writeRunnerAgentLogins({ disconnected: ['claude', 'codex'] });
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ ...bundle, connect: 'claude' }, publicKey),
    });
    expect(res.json().agents).toMatchObject({ claude: 'written', codex: 'skipped' });
    const stored = await readRunnerAgentLogins();
    expect(stored.claudeToken).toBe('sk-ant-oat01-CLAUDESECRET');
    expect(stored.volume?.codex).toBeUndefined();
    expect(stored.disconnected).toEqual(['codex']);
    expect(Object.keys(writeVolume.mock.calls[0]![1])).toEqual(['claude']);
  });

  it('an unknown connect value is refused', async () => {
    const { publicKey } = await boxKey();
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ ...bundle, connect: 'gemini' as never }, publicKey),
    });
    expect(res.statusCode).toBe(400);
  });

  it('changedAt moves only for agents whose stored value changed', async () => {
    const { publicKey } = await boxKey();
    await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    const first = (await readRunnerAgentLogins()).changedAt!;
    expect(first).toEqual({ claude: expect.any(Number), codex: expect.any(Number) });
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ ...bundle, codex: { apiKey: 'sk-CODEXNEW' } }, publicKey),
    });
    const second = (await readRunnerAgentLogins()).changedAt!;
    expect(second.claude).toBe(first.claude);
    expect(second.codex).toBeGreaterThan(first.codex!);
  });

  it('a refreshable oauth entry is refused whole', async () => {
    const { publicKey } = await boxKey();
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ pi: { providers: { google: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } as never } } }, publicKey),
    });
    expect(res.statusCode).toBe(400);
    expect(await readRunnerAgentLogins()).toEqual({});
  });

  it('volume errors → per-agent failed with a fixed log line, no throw', async () => {
    findImage.mockRejectedValueOnce(new Error('ls failed: sk-CODEXSECRET'));
    const { publicKey } = await boxKey();
    const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual({ claude: 'failed', codex: 'failed', opencode: 'skipped', pi: 'skipped' });
    expect(logs).toContain('agent-login sync failed: volume');
    expect(logs.join('\n')).not.toContain('CODEXSECRET');
  });

  it('response and logs never contain token or key strings', async () => {
    writeVolume.mockResolvedValueOnce({ claude: 'failed', codex: 'failed', opencode: 'skipped', pi: 'skipped' });
    const { publicKey } = await boxKey();
    const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    for (const s of [res.body, ...logs]) {
      expect(s).not.toContain('CLAUDESECRET');
      expect(s).not.toContain('CODEXSECRET');
    }
  });

  it('an unsigned or re-signed bundle is rejected before opening', async () => {
    const { publicKey } = await boxKey();
    const sealed = seal(bundle, publicKey);
    const bad = Buffer.from(sealed.sig, 'base64');
    bad[0]! ^= 1;
    for (const payload of [{ ...sealed, sig: bad.toString('base64') }, { ...sealed, spk: generateSenderKey().publicKey }]) {
      const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('sealed bundle rejected');
    }
    expect(await readRunnerAgentLogins()).toEqual({});
  });

  it('pins the first sender; another laptop gets 403 and nothing is stored', async () => {
    const { publicKey } = await boxKey();
    expect((await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) })).statusCode).toBe(200);
    const pinFile = path.join(tmp, 'runner-sender-pin.json');
    expect((await fs.stat(pinFile)).mode & 0o777).toBe(0o600);

    const before = await readRunnerAgentLogins();
    const other = generateSenderKey();
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ codex: { apiKey: 'sk-OTHER' } }, publicKey, other),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('sender not trusted by this runner');
    expect(await readRunnerAgentLogins()).toEqual(before);
    expect(logs.some((l) => l.includes(pinFile))).toBe(true);

    // Deleting the pin file is the reset.
    await fs.rm(pinFile);
    expect(
      (await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal({ codex: { apiKey: 'sk-OTHER' } }, publicKey, other) }))
        .statusCode,
    ).toBe(200);
  });

  it('a pinned sender is not pinned by a bundle that fails to open', async () => {
    const { publicKey } = await boxKey();
    const sealedElsewhere = seal(bundle, generateBoxKey().publicKey, generateSenderKey());
    expect((await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: sealedElsewhere })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) })).statusCode).toBe(200);
  });

  it('replayed or older bundle → 409 stale, store untouched', async () => {
    const { publicKey } = await boxKey();
    const first = seal(bundle, publicKey);
    expect((await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: first })).statusCode).toBe(200);
    const before = await readRunnerAgentLogins();
    for (const payload of [first, seal({ codex: { apiKey: 'sk-OLD' } }, publicKey, sender, 5)]) {
      const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('stale bundle');
    }
    expect(await readRunnerAgentLogins()).toEqual(before);
  });

  it('a relay re-signing the laptop bundle with its own key gets 400 and no pin', async () => {
    const { publicKey } = await boxKey();
    const { spk: _s, sig: _g, ...unsigned } = seal(bundle, publicKey);
    const relay = generateSenderKey();
    const res = await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: signSealed(unsigned, relay.privateKey) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('sealed bundle rejected');
    await expect(fs.stat(path.join(tmp, 'runner-sender-pin.json'))).rejects.toThrow();
    expect(await readRunnerAgentLogins()).toEqual({});
  });

  it('logs the trusted laptop fingerprint when the pin is first written', async () => {
    const { publicKey } = await boxKey();
    await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey) });
    expect(logs).toContain(`[runner] login-sync trusted laptop ${fingerprintOf(sender.publicKey)}`);
  });

  it('re-pinning resets the replay floor for the new laptop', async () => {
    const { publicKey } = await boxKey();
    await app.inject({ method: 'POST', url: AGENT_LOGIN_PATHS.sync, payload: seal(bundle, publicKey, sender, 2_000_000_000_000) });
    await fs.rm(path.join(tmp, 'runner-sender-pin.json'));
    const behind = generateSenderKey();
    const res = await app.inject({
      method: 'POST',
      url: AGENT_LOGIN_PATHS.sync,
      payload: seal({ codex: { apiKey: 'sk-NEW' } }, publicKey, behind, 1_000),
    });
    expect(res.statusCode).toBe(200);
    expect((await readRunnerAgentLogins()).lastIssuedAt).toBe(1_000);
  });
});
