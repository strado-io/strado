import { describe, expect, it, vi } from 'vitest';
import type { SpawnSpec } from '../terminalManager.js';
import { createSetupRun, runSshSetup, type SetupDeps } from './job.js';
import type { ExecResult, SshSession } from './session.js';
import { SSH_SETUP_KEY_PREFIX, type RemoteFacts, type SshSetupQuestion } from './types.js';

const PAIR_CODE = 'PAIR-SECR-ET99';
const HOME = '/home/u';
const BIN = `${HOME}/.strado/runner/bin/strado-runner`;

function facts(over: Partial<RemoteFacts> = {}): RemoteFacts {
  return {
    system: 'Linux', machine: 'x86_64', glibc: '2.39', musl: false, machineId: 'abc', home: HOME, user: 'u', uid: 1000,
    hostname: 'box', freeKiB: 50_000_000, tools: { curl: true, tar: true, sha256sum: true }, releaseReachable: true,
    systemdUser: true, linger: true, runner: { version: null, pairedRunnerId: null },
    podman: { version: '4.9.3', rootless: true, subuid: true, newuidmap: true, cgroup2: true }, docker: false,
    distro: 'ubuntu', gh: 'signed-in', ...over,
  };
}

type Call = { kind: 'run' | 'exec'; what: string; stdin?: string };

/** Everything the job touches, faked: session, pty, cloud, scripts. */
function harness(o: {
  facts?: RemoteFacts;
  feed?: string | null;
  runners?: string[];
  answers?: Partial<Record<SshSetupQuestion['kind'], boolean>>;
  ptyCodes?: number[];
  pairOut?: string;
  onlineAfter?: number;
  installCode?: number;
  refusal?: string | null;
  podmanNeeded?: boolean;
  podmanCmd?: string | null;
} = {}) {
  const calls: Call[] = [];
  const ptySpecs: SpawnSpec[] = [];
  const frames: { message: string; data?: unknown }[] = [];
  const questions: SshSetupQuestion[] = [];
  const ptyCodes = [...(o.ptyCodes ?? [])];
  let closed = 0;
  let onlinePolls = 0;
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

  const session: SshSession = {
    controlDir: '/tmp/strado-ssh-x',
    connectSpec: () => ({ file: 'ssh', args: ['connect'] }),
    ttySpec: (script) => ({ file: 'ssh', args: ['tty', script] }),
    run: vi.fn(async (script: string, stdin?: string, onLine?: (l: string) => void) => {
      calls.push({ kind: 'run', what: script, stdin });
      if (script === 'PROBE') return ok('probe-out');
      if (script.includes('install-runner.sh')) { onLine?.('installing 0.1.32'); return { code: o.installCode ?? 0, stdout: '', stderr: '' }; }
      return ok();
    }),
    exec: vi.fn(async (argv: string[], stdin?: string) => {
      calls.push({ kind: 'exec', what: argv.join(' '), stdin });
      if (argv[1] === 'pair') return ok(o.pairOut ?? 'paired\nrunnerId=r-new\n');
      return ok();
    }),
    close: vi.fn(async () => { closed++; }),
  };

  const exits = new Map<string, (code: number) => void>();
  const run = createSetupRun();
  const deps: SetupDeps = {
    openSession: async () => session,
    terminal: {
      ensure: vi.fn(async (key: string, _cwd: string, spec?: SpawnSpec) => {
        ptySpecs.push(spec!);
        const code = ptyCodes.shift() ?? 0;
        setTimeout(() => exits.get(key)?.(code), 1);
        return { status: 'running' as const, pid: 1, exitCode: null };
      }),
      onExit: (key: string, cb: (code: number) => void) => { exits.set(key, cb); return () => exits.delete(key); },
      status: () => ({ status: 'running' as const, pid: 1, exitCode: null }),
      kill: vi.fn(),
    },
    home: '/Users/me',
    apiUrl: 'https://api.test',
    cloud: {
      listRunnerIds: async () => o.runners ?? [],
      mintPairCode: async () => PAIR_CODE,
      isOnline: async () => { onlinePolls++; return onlinePolls > (o.onlineAfter ?? 0); },
    },
    feedVersion: async () => (o.feed === undefined ? '0.1.32' : o.feed),
    probeScript: 'PROBE',
    parseProbe: () => o.facts ?? facts(),
    refusal: () => o.refusal ?? null,
    warnings: () => [],
    podmanNeeded: () => o.podmanNeeded ?? false,
    podmanInstallCommand: () => (o.podmanCmd === undefined ? 'sudo apt-get install -y podman uidmap slirp4netns' : o.podmanCmd),
    recordHost: vi.fn(async () => {}),
    sleep: async () => {},
    pollTimeoutMs: 120_000,
    pollIntervalMs: 3_000,
  };
  const ctx = {
    progress: (message: string, data?: unknown) => {
      frames.push({ message, data });
      const q = (data as { question?: SshSetupQuestion } | undefined)?.question;
      if (q) {
        questions.push(q);
        const yes = o.answers?.[q.kind];
        if (yes !== undefined) setTimeout(() => run.answer(q.id, yes), 1);
      }
    },
  };
  const go = (name: string | null = 'box') =>
    runSshSetup(ctx, { jobId: 'job1', dest: { target: 'u@h', port: null }, name }, deps, run);
  return { go, calls, ptySpecs, frames, questions, deps, run, session, closed: () => closed };
}

const steps = (frames: { data?: unknown }[]) =>
  [...new Set(frames.map((f) => (f.data as { step?: string } | undefined)?.step).filter(Boolean))];

describe('runSshSetup', () => {
  it('happy path: connect in the pty, probe, install, pair, service, online; records the host', async () => {
    const h = harness();
    const res = await h.go();
    expect(res).toEqual({ runnerId: 'r-new', name: 'box', sandboxes: true, warnings: [] });
    expect(steps(h.frames)).toEqual(['connect', 'check', 'install', 'pair', 'service', 'podman', 'online']);
    expect(h.ptySpecs[0]).toEqual({ file: 'ssh', args: ['connect'] });
    expect(h.deps.terminal.ensure).toHaveBeenCalledWith(`${SSH_SETUP_KEY_PREFIX}job1`, '/Users/me', { file: 'ssh', args: ['connect'] });
    expect(h.frames.some((f) => (f.data as { terminal?: { key: string } }).terminal?.key === `${SSH_SETUP_KEY_PREFIX}job1`)).toBe(true);
    const probe = h.calls.find((c) => c.what === 'PROBE')!;
    expect(probe.stdin).toBe('https://api.test\n');
    expect(h.calls.find((c) => c.what.includes('install-runner.sh'))!.what).toBe('read api; curl -fsSL "$api/install-runner.sh" | STRADO_API_URL="$api" sh');
    const pair = h.calls.find((c) => c.what.includes(' pair '))!;
    expect(pair.what).toBe(`${BIN} pair --code - --api https://api.test --name box`);
    expect(pair.stdin).toBe(`${PAIR_CODE}\n`);
    expect(h.calls.some((c) => c.what === `${BIN} install-service`)).toBe(true);
    expect(h.deps.recordHost).toHaveBeenCalledWith('r-new', expect.objectContaining({ target: 'u@h', port: null, lastInstallVersion: '0.1.32' }));
    expect(h.closed()).toBe(1);
  });

  it('the pair code never appears in any argv, pty spec, frame, or stdin other than the pair exec', async () => {
    const h = harness();
    await h.go();
    const stdinUse = h.calls.filter((c) => c.stdin?.includes(PAIR_CODE));
    expect(stdinUse).toHaveLength(1);
    expect(JSON.stringify(h.calls.map((c) => c.what))).not.toContain(PAIR_CODE);
    expect(JSON.stringify(h.ptySpecs)).not.toContain(PAIR_CODE);
    expect(JSON.stringify(h.frames)).not.toContain(PAIR_CODE);
  });

  it('a failed connect (pty exit ≠ 0) errors with a fixed message and closes the session', async () => {
    const h = harness({ ptyCodes: [255] });
    await expect(h.go()).rejects.toThrow('could not connect');
    expect(h.closed()).toBe(1);
  });

  it('a refusal stops at check, before anything is installed', async () => {
    const h = harness({ refusal: 'this box is arm64; runners need x86_64' });
    await expect(h.go()).rejects.toThrow('this box is arm64; runners need x86_64');
    expect(h.calls.some((c) => c.what.includes('install-runner.sh'))).toBe(false);
    expect(h.closed()).toBe(1);
  });

  it('same version installed → install skipped', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.32', pairedRunnerId: null } }) });
    await h.go();
    expect(h.calls.some((c) => c.what.includes('install-runner.sh'))).toBe(false);
  });

  it('a hand-built version asks before overwriting; no keeps it', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.33-als', pairedRunnerId: null } }), answers: { 'overwrite-install': false } });
    await h.go();
    expect(h.questions.map((q) => q.kind)).toEqual(['overwrite-install']);
    expect(h.calls.some((c) => c.what.includes('install-runner.sh'))).toBe(false);
  });

  it('a hand-built version, yes → installs', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.31-als', pairedRunnerId: null } }), answers: { 'overwrite-install': true } });
    await h.go();
    expect(h.calls.some((c) => c.what.includes('install-runner.sh'))).toBe(true);
  });

  it('newer than the feed asks too', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.2.0', pairedRunnerId: null } }), answers: { 'overwrite-install': false } });
    await h.go();
    expect(h.questions.map((q) => q.kind)).toEqual(['overwrite-install']);
  });

  it('an older version upgrades without asking; install output streams as detail', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.20', pairedRunnerId: null } }) });
    await h.go();
    expect(h.questions).toEqual([]);
    expect(h.frames.some((f) => (f.data as { detail?: string }).detail === 'installing 0.1.32')).toBe(true);
  });

  it('a failed install is a fixed error', async () => {
    const h = harness({ installCode: 1 });
    await expect(h.go()).rejects.toThrow('install failed');
  });

  it('already paired to this account → no new pair code, same runner id', async () => {
    const mint = vi.fn();
    const h = harness({ facts: facts({ runner: { version: '0.1.32', pairedRunnerId: 'r-old' } }), runners: ['r-old'] });
    h.deps.cloud.mintPairCode = mint;
    const res = await h.go();
    expect(mint).not.toHaveBeenCalled();
    expect(res.runnerId).toBe('r-old');
    expect(h.calls.some((c) => c.what.includes(' pair '))).toBe(false);
  });

  it('paired to another account: asks; yes re-pairs with --force', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.32', pairedRunnerId: 'r-theirs' } }), answers: { 'repair-other-account': true } });
    await h.go();
    expect(h.questions.map((q) => q.kind)).toEqual(['repair-other-account']);
    expect(h.calls.find((c) => c.what.includes(' pair '))!.what).toContain(' --force');
  });

  it('paired to another account: no leaves the box alone', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.32', pairedRunnerId: 'r-theirs' } }), answers: { 'repair-other-account': false } });
    await expect(h.go()).rejects.toThrow('paired to another account');
    expect(h.calls.some((c) => c.what.includes(' pair '))).toBe(false);
    expect(h.closed()).toBe(1);
  });

  it('pair output without runnerId= is a fixed failure that never echoes the output', async () => {
    const h = harness({ pairOut: 'error: code PAIR-SECR-ET99 expired' });
    const err = await h.go().then(() => null, (e: Error) => e);
    expect(err!.message).toBe('pairing failed on the box');
    expect(JSON.stringify(err)).not.toContain(PAIR_CODE);
  });

  it('linger off: asks; yes runs it in the pty', async () => {
    const h = harness({ facts: facts({ linger: false }), answers: { linger: true } });
    await h.go();
    const q = h.questions.find((x) => x.kind === 'linger')!;
    expect(q.command).toContain('enable-linger');
    expect(h.ptySpecs[1]).toEqual({ file: 'ssh', args: ['tty', q.command] });
  });

  it('linger off: no → a warning, not an error', async () => {
    const h = harness({ facts: facts({ linger: false }), answers: { linger: false } });
    const res = await h.go();
    expect(h.ptySpecs).toHaveLength(1);
    expect(res.warnings.join(' ')).toMatch(/log out/);
  });

  it('podman needed: yes runs the exact command in the pty, then exactly one runner restart', async () => {
    const h = harness({ podmanNeeded: true, answers: { podman: true } });
    const res = await h.go();
    const q = h.questions.find((x) => x.kind === 'podman')!;
    expect(q.command).toBe('sudo apt-get install -y podman uidmap slirp4netns');
    expect(h.ptySpecs.at(-1)).toEqual({ file: 'ssh', args: ['tty', q.command] });
    expect(h.calls.filter((c) => c.what.includes('systemctl --user restart strado-runner'))).toHaveLength(1);
    expect(res.sandboxes).toBe(true);
  });

  it('podman yes but the install fails in the terminal → sandboxes false, a warning, still done', async () => {
    const h = harness({ podmanNeeded: true, answers: { podman: true }, ptyCodes: [0, 1] });
    const res = await h.go();
    expect(res.sandboxes).toBe(false);
    expect(res.warnings.length).toBe(1);
  });

  it('the ssh master dying mid-run is a fixed error; pty killed, session closed', async () => {
    const h = harness();
    (h.session.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ code: 255, stdout: '', stderr: 'Control socket connect: Connection refused' });
    const err = await h.go().then(() => null, (e: Error) => e);
    expect(err!.message).toBe('could not check the machine');
    expect(h.deps.terminal.kill).toHaveBeenCalled();
    expect(h.closed()).toBe(1);
  });

  it('podman declined or failed → no restart', async () => {
    const declined = harness({ podmanNeeded: true, answers: { podman: false } });
    await declined.go();
    const failed = harness({ podmanNeeded: true, answers: { podman: true }, ptyCodes: [0, 1] });
    await failed.go();
    for (const h of [declined, failed]) expect(h.calls.some((c) => c.what.includes('systemctl --user restart'))).toBe(false);
  });

  it('a probe that never answers is a fixed error (the probe gets a timeout)', async () => {
    const h = harness();
    (h.session.run as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_s: string, _i: string, _l: unknown, timeoutMs?: number) => {
      expect(timeoutMs).toBe(30_000);
      return { code: 255, stdout: '', stderr: '' };
    });
    await expect(h.go()).rejects.toThrow('could not check the machine');
  });

  it('kept runner older than 0.1.32 that needs pairing: fails before pairing', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.31-als', pairedRunnerId: null } }), answers: { 'overwrite-install': false } });
    await expect(h.go()).rejects.toThrow("the runner on this box is older than 0.1.32 and can't pair over SSH — allow the upgrade and retry");
    expect(h.calls.some((c) => c.what.includes(' pair '))).toBe(false);
  });

  // Found live on a fresh box: the feed served 0.1.31, setup installed it, then
  // told the user to "allow the upgrade" — there was nothing newer to allow.
  it('the published runner is too old to pair: stops before installing, and says so', async () => {
    const h = harness({ feed: '0.1.31', facts: facts({ runner: { version: null, pairedRunnerId: null } }) });
    await expect(h.go()).rejects.toThrow(
      "the published runner (0.1.31) can't pair over SSH yet — it needs runner 0.1.32 or newer",
    );
    expect(h.calls.some((c) => c.what.includes('install-runner.sh'))).toBe(false);
  });

  it('a too-old published runner is fine when the box already runs a new enough one', async () => {
    const h = harness({ feed: '0.1.31', facts: facts({ runner: { version: '0.1.32', pairedRunnerId: null } }), answers: { 'overwrite-install': false } });
    await expect(h.go()).resolves.toMatchObject({ runnerId: expect.any(String) });
  });

  it('feed unreachable and an old runner kept → same fixed error', async () => {
    const h = harness({ feed: null, facts: facts({ runner: { version: '0.1.20', pairedRunnerId: null } }) });
    await expect(h.go()).rejects.toThrow('older than 0.1.32');
  });

  it('an old runner already paired to this account needs no pairing, so it is fine', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.31-als', pairedRunnerId: 'r-old' } }), runners: ['r-old'], answers: { 'overwrite-install': false } });
    expect((await h.go()).runnerId).toBe('r-old');
  });

  it('podman declined → sandboxes false with a warning', async () => {
    const h = harness({ podmanNeeded: true, answers: { podman: false } });
    const res = await h.go();
    expect(res.sandboxes).toBe(false);
    expect(res.warnings.join(' ')).toMatch(/sandbox/i);
  });

  it('podman needed on an unknown distro → no question, sandboxes false, warning', async () => {
    const h = harness({ podmanNeeded: true, podmanCmd: null });
    const res = await h.go();
    expect(h.questions).toEqual([]);
    expect(res.sandboxes).toBe(false);
    expect(res.warnings.length).toBe(1);
  });

  it('never online within the window → fixed error with the journalctl hint', async () => {
    const h = harness({ onlineAfter: 1_000 });
    await expect(h.go()).rejects.toThrow('journalctl --user -u strado-runner -n 50');
    expect(h.closed()).toBe(1);
  });

  it('cancel while a question is open: pty killed, session closed, fixed error', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.31-als', pairedRunnerId: null } }) });
    const p = h.go();
    await vi.waitFor(() => expect(h.questions).toHaveLength(1));
    h.run.cancel();
    await expect(p).rejects.toThrow('setup cancelled');
    expect(h.deps.terminal.kill).toHaveBeenCalledWith(`${SSH_SETUP_KEY_PREFIX}job1`);
    expect(h.closed()).toBe(1);
  });

  it('cancel while the session is still opening: the opened session is closed anyway', async () => {
    const h = harness();
    let opened: (() => void) | undefined;
    h.deps.openSession = () => new Promise((resolve) => { opened = () => resolve(h.session); });
    const p = h.go();
    await vi.waitFor(() => expect(opened).toBeTypeOf('function'));
    h.run.cancel();
    opened!();
    await expect(p).rejects.toThrow('setup cancelled');
    expect(h.closed()).toBe(1);
    expect(h.deps.terminal.ensure).not.toHaveBeenCalled();
  });

  it('an answer to an unknown question is refused', () => {
    expect(createSetupRun().answer('nope', true)).toBe(false);
  });
});

describe('runSshSetup: the transcript', () => {
  const lines = (frames: { data?: unknown }[]) =>
    frames.map((f) => (f.data as { detail?: string } | undefined)?.detail).filter((d): d is string => typeof d === 'string');

  it('every step writes a header, the probe summary, outcomes and the online polls, as detail frames and in the run ring', async () => {
    const h = harness({ onlineAfter: 2, facts: facts({ linger: false }), answers: { linger: true } });
    await h.go();
    const t = lines(h.frames);
    for (const head of ['▸ Connect', '▸ Check machine', '▸ Install', '▸ Pair', '▸ Service', '▸ Podman', '▸ Online']) expect(t).toContain(head);
    expect(t).toContain('OS: ubuntu x86_64, glibc 2.39');
    expect(t).toContain('podman 4.9.3 · systemd user session: yes · linger: off');
    expect(t).toContain('strado-runner: not installed · not paired');
    expect(t).toContain('installing 0.1.32');
    expect(t).toContain('Paired as r-new');
    expect(t).toContain('Runner service installed');
    expect(t).toContain('Linger enabled');
    expect(t).toContain('podman 4.9.3 found — sandboxes on');
    expect(t).toContain('waiting for the runner to come online… (1)');
    expect(t).toContain('waiting for the runner to come online… (2)');
    expect(t.at(-1)).toBe('Online as box');
    expect(h.run.transcript).toEqual(t);
    // Headers come in step order.
    expect(t.filter((l) => l.startsWith('▸ '))).toEqual(['▸ Connect', '▸ Check machine', '▸ Install', '▸ Pair', '▸ Service', '▸ Podman', '▸ Online']);
  });

  it('probe warnings are listed; an existing runner and its pairing are named', async () => {
    const h = harness({ facts: facts({ runner: { version: '0.1.32', pairedRunnerId: 'r-old' } }), runners: ['r-old'] });
    h.deps.warnings = () => ['low disk space'];
    await h.go();
    const t = lines(h.frames);
    expect(t).toContain('strado-runner: 0.1.32 · paired to your account');
    expect(t).toContain('⚠ low disk space');
    expect(t).toContain('Already paired to your account as r-old');
  });

  it('the failure reason is the last line', async () => {
    const h = harness({ installCode: 1 });
    await expect(h.go()).rejects.toThrow('install failed');
    expect(lines(h.frames).at(-1)).toBe('✗ install failed — see the output above');
  });

  it('a cancel ends the transcript with the cancel line', async () => {
    const h = harness({ facts: facts({ linger: false }) });
    const p = h.go();
    await vi.waitFor(() => expect(h.questions.length).toBe(1));
    h.run.cancel();
    await expect(p).rejects.toThrow('setup cancelled');
    expect(h.run.transcript.at(-1)).toBe('✗ setup cancelled');
  });

  it('never the pair code or raw pair output; box output is stripped of escapes and cut', async () => {
    const h = harness({ pairOut: `SECRET-PAIR-STDOUT\nrunnerId=r-new\n` });
    (h.session.run as ReturnType<typeof vi.fn>).mockImplementation(async (script: string, _stdin?: string, onLine?: (l: string) => void) => {
      if (script === 'PROBE') return { code: 0, stdout: 'probe-out', stderr: '' };
      if (script.includes('install-runner.sh')) {
        onLine?.(`\x1b[32mok\x1b[0m\x07 ${'x'.repeat(900)}`);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    await h.go();
    const all = JSON.stringify(h.run.transcript);
    expect(all).not.toContain(PAIR_CODE);
    expect(all).not.toContain('SECRET-PAIR-STDOUT');
    const out = h.run.transcript.find((l) => l.startsWith('ok '))!;
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out.length).toBeLessThanOrEqual(500);
  });

  it('the ring keeps the last 2000 lines', async () => {
    const h = harness();
    (h.session.run as ReturnType<typeof vi.fn>).mockImplementation(async (script: string, _stdin?: string, onLine?: (l: string) => void) => {
      if (script === 'PROBE') return { code: 0, stdout: 'probe-out', stderr: '' };
      if (script.includes('install-runner.sh')) for (let i = 0; i < 2500; i++) onLine?.(`line ${i}`);
      return { code: 0, stdout: '', stderr: '' };
    });
    await h.go();
    expect(h.run.transcript).toHaveLength(2000);
    expect(h.run.transcript.at(-1)).toBe('Online as box');
  });
});
