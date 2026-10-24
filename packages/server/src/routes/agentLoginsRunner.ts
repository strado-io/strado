// Runner side of agent-login sync. The laptop fetches the box key, seals its
// logins to it, and POSTs the sealed bundle here through the relay — which
// only ever carries ciphertext.
//
// Everything that can fail on this path fails with a fixed string. The laptop's
// runner client echoes far-side error bodies, and the request carries secrets,
// so no error text, zod issue or exec output may reach a response or a log.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { realExec, type ExecFn, type SandboxRuntime } from '../services/sandbox/runtime.js';
import type { SandboxService } from '../services/sandbox/sandboxes.js';
import { fingerprintOf, openBundle, verifySealed } from '../services/agentLogins/seal.js';
import { readSenderPin, runnerSenderPinPath, writeSenderPin } from '../services/agentLogins/senderPin.js';
import { loadOrCreateBoxKey } from '../services/agentLogins/runnerKey.js';
import {
  readRunnerAgentLogins,
  markChanged,
  withRunnerStoreLock,
  writeRunnerAgentLogins,
  type RunnerAgentLogins,
  type StoredVolume,
} from '../services/agentLogins/runnerStore.js';
import { writeHomeVolume, type VolumePayload } from '../services/agentLogins/volumeWriter.js';
import {
  AGENT_LOGIN_PATHS,
  type AgentLoginBundle,
  type AgentName,
  type AgentOutcome,
  type BoxKeyInfo,
  type RunnerSyncResult,
} from '../services/agentLogins/types.js';

const b64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const SealedBody = z.object({
  v: z.literal(1),
  epk: b64(64),
  iv: b64(32),
  ct: b64(256 * 1024),
  tag: b64(32),
  spk: b64(64),
  sig: b64(128),
});

// Only the fields that make a login: anything else on an entry is dropped.
const StaticProviders = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  z.union([
    z.object({ type: z.literal('api'), key: z.string().min(1).max(4096) }),
    z.object({ type: z.literal('oauth'), access: z.string().min(1).max(4096), refresh: z.literal(''), expires: z.number() }),
  ]),
);

// What a successfully opened bundle must look like before anything is written.
const Bundle: z.ZodType<AgentLoginBundle> = z.object({
  issuedAt: z.number().int().positive(),
  claude: z
    .object({
      token: z.string().min(1).max(4096),
      oauthAccount: z.record(z.unknown()).optional(),
      lastOnboardingVersion: z.string().max(64).optional(),
    })
    .optional(),
  codex: z.object({ apiKey: z.string().min(1).max(4096) }).optional(),
  opencode: z.object({ providers: StaticProviders }).optional(),
  pi: z.object({ providers: StaticProviders }).optional(),
  connect: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
});

const AGENTS: AgentName[] = ['claude', 'codex', 'opencode', 'pi'];

/** Any built sandbox image will do: the writer only needs `node`. */
export async function anySandboxImage(rt: SandboxRuntime, exec: ExecFn): Promise<string | null> {
  // Filtered here, not with --filter reference=: podman names local builds
  // `localhost/strado-sandbox`, which the two runtimes' filters match differently.
  const r = await exec(rt.bin, ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((l) => l.trim()).find((l) => /(^|\/)strado-sandbox:/.test(l) && !l.endsWith(':<none>')) ?? null;
}

export async function registerAgentLoginsRunnerRoutes(
  app: FastifyInstance,
  deps: {
    sandbox: Pick<SandboxService, 'ensureHomeVolume' | 'userArgs'>;
    sandboxRuntime: SandboxRuntime;
    exec?: ExecFn;
    /** Seams for the tests; default to the real image lookup and volume write. */
    findImage?: (rt: SandboxRuntime) => Promise<string | null>;
    writeVolume?: typeof writeHomeVolume;
    log?: (line: string) => void;
  },
): Promise<void> {
  const exec = deps.exec ?? realExec;
  const findImage = deps.findImage ?? ((rt: SandboxRuntime) => anySandboxImage(rt, exec));
  const writeVolume = deps.writeVolume ?? writeHomeVolume;
  const log = deps.log ?? (() => {});

  app.get(AGENT_LOGIN_PATHS.boxKey, async (): Promise<BoxKeyInfo> => {
    try {
      const { publicKey, fingerprint } = await loadOrCreateBoxKey();
      return { publicKey, fingerprint };
    } catch {
      log('agent-login sync failed: box key');
      throw new AppError('SHELL_FAILED', 'runner box key unavailable');
    }
  });

  // One store writer at a time (sync, disconnect, device logins): the pin and
  // the replay check read, then write.
  app.post(AGENT_LOGIN_PATHS.sync, async (req): Promise<RunnerSyncResult> => {
    const sealed = SealedBody.safeParse(req.body);
    // The signature before anything else: an unsigned bundle never costs a
    // decrypt, and never reaches the pin.
    if (!sealed.success || !verifySealed(sealed.data)) throw new AppError('VALIDATION', 'sealed bundle rejected');
    return withRunnerStoreLock(() => sync(sealed.data));
  });

  async function sync(sealed: z.infer<typeof SealedBody>): Promise<RunnerSyncResult> {
    let pinned: string | null;
    try {
      pinned = await readSenderPin();
    } catch {
      log(`agent-login sync failed: sender pin unreadable — delete ${runnerSenderPinPath()} to re-pin`);
      throw new AppError('FORBIDDEN', 'sender not trusted by this runner');
    }
    if (pinned && pinned !== sealed.spk) {
      log(`agent-login sync refused: sender is not the pinned laptop — delete ${runnerSenderPinPath()} to trust a new one`);
      throw new AppError('FORBIDDEN', 'sender not trusted by this runner');
    }

    let key: Awaited<ReturnType<typeof loadOrCreateBoxKey>>;
    try {
      key = await loadOrCreateBoxKey();
    } catch {
      log('agent-login sync failed: box key');
      throw new AppError('SHELL_FAILED', 'runner box key unavailable');
    }

    let bundle: AgentLoginBundle;
    try {
      const parsed = Bundle.safeParse(openBundle(sealed, key.privateKey, key.publicKey));
      if (!parsed.success) throw new Error();
      bundle = parsed.data;
    } catch {
      log('agent-login sync failed: open');
      throw new AppError('VALIDATION', 'sealed bundle rejected');
    }

    // Replay is judged per pinned laptop: a newly trusted one starts fresh, so
    // moving to a laptop whose clock is behind is not stale forever.
    const lastIssuedAt = pinned ? (await readRunnerAgentLogins()).lastIssuedAt : undefined;
    if (lastIssuedAt !== undefined && bundle.issuedAt <= lastIssuedAt) {
      log('agent-login sync refused: stale bundle');
      throw new AppError('CONFLICT', 'stale bundle');
    }
    // Trust on first use, and only once a bundle has verified AND opened: a
    // bundle sealed to some other runner must not claim the pin here.
    if (!pinned) {
      try {
        await writeSenderPin(sealed.spk);
        const line = `[runner] login-sync trusted laptop ${fingerprintOf(sealed.spk)}`;
        console.log(line);
        log(line);
      } catch {
        log('agent-login sync failed: sender pin');
        throw new AppError('SHELL_FAILED', 'agent-login sync failed');
      }
    }

    const agents = Object.fromEntries(AGENTS.map((a) => [a, 'skipped'])) as Record<AgentName, AgentOutcome>;
    // Disconnected agents are skipped: an auto-sync re-sends everything, and
    // a Disconnect must stick. Only an explicit Connect of that agent (named
    // inside the signed body) brings it back.
    let present = AGENTS.filter((a) => bundle[a]);

    // Store first, before any container work: the laptop waits seconds, not
    // the minutes a fresh runner's image build takes, and every sandbox
    // provision re-applies what is stored here.
    let stored: RunnerAgentLogins;
    let prevVolume: StoredVolume | undefined;
    try {
      const cur = await readRunnerAgentLogins();
      const disconnected = new Set(cur.disconnected ?? []);
      if (bundle.connect) disconnected.delete(bundle.connect);
      present = present.filter((a) => !disconnected.has(a));
      const take = (a: AgentName) => present.includes(a);
      prevVolume = cur.volume;
      const volume: StoredVolume = { ...cur.volume };
      if (bundle.claude && take('claude')) {
        volume.claude = {
          ...(bundle.claude.oauthAccount ? { oauthAccount: bundle.claude.oauthAccount } : {}),
          ...(bundle.claude.lastOnboardingVersion ? { lastOnboardingVersion: bundle.claude.lastOnboardingVersion } : {}),
        };
      }
      if (bundle.codex && take('codex')) volume.codex = bundle.codex;
      if (bundle.opencode && take('opencode')) volume.opencode = bundle.opencode;
      if (bundle.pi && take('pi')) volume.pi = bundle.pi;
      stored = {
        ...cur,
        lastIssuedAt: bundle.issuedAt,
        volume,
        disconnected: [...disconnected],
        ...(bundle.claude && take('claude') ? { claudeToken: bundle.claude.token.trim() } : {}),
      };
      const facet = (s: RunnerAgentLogins, a: AgentName) =>
        JSON.stringify(a === 'claude' ? [s.claudeToken, s.volume?.claude] : s.volume?.[a]);
      for (const a of present) agents[a] = facet(cur, a) === facet(stored, a) ? 'unchanged' : 'written';
      stored = markChanged(stored, present.filter((a) => agents[a] === 'written'));
      await writeRunnerAgentLogins(stored);
    } catch {
      log('agent-login sync failed: store');
      for (const a of present) agents[a] = 'failed';
      return { fingerprint: key.fingerprint, agents };
    }

    if (present.length === 0) return { fingerprint: key.fingerprint, agents };

    // Existing sandboxes share the HOME volume, so write it now too — but only
    // when an image is already here. Never build one on this path; a runner
    // that has no image has no sandboxes yet, and its first provision applies
    // the stored payload.
    const payload: VolumePayload = {};
    for (const a of present) Object.assign(payload, { [a]: stored.volume?.[a] ?? {} });
    // What was sent before, so ids dropped from this bundle are removed and
    // only ids this runner was sent are replaced.
    for (const a of ['opencode', 'pi'] as const) {
      if (payload[a]) payload[a] = { ...payload[a]!, prev: prevVolume?.[a]?.providers ?? {} };
    }
    let written: Record<AgentName, AgentOutcome>;
    try {
      const image = await findImage(deps.sandboxRuntime);
      if (!image) {
        // Stored, and the first sandbox's provision writes it. Codex and
        // OpenCode live only in the volume, so they are not usable until then;
        // Claude's token already is (it goes in via env at create).
        for (const a of present) if (a !== 'claude') agents[a] = 'pending';
        return { fingerprint: key.fingerprint, agents };
      }
      await deps.sandbox.ensureHomeVolume(image);
      written = await writeVolume(
        { rt: deps.sandboxRuntime, exec, image, userArgs: deps.sandbox.userArgs() },
        payload,
      );
    } catch {
      log('agent-login sync failed: volume');
      for (const a of present) agents[a] = 'failed';
      return { fingerprint: key.fingerprint, agents };
    }
    for (const a of present) {
      if (written[a] === 'failed') {
        log(`agent-login sync failed: volume ${a}`);
        agents[a] = 'failed';
      } else if (written[a] === 'written') {
        // Stored copy unchanged but the volume was missing it (wiped, or a
        // container logged out): still news to the user.
        agents[a] = 'written';
      }
    }
    return { fingerprint: key.fingerprint, agents };
  }
}
