import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSetupToken, createSharedCapture, extractToken, SETUP_TOKEN_ERRORS, type PtyLike, type SpawnPty } from './claudeSetupToken.js';

const TOKEN = `sk-ant-oat01-${'Ab3_-x'.repeat(16)}`;

/** A fake pty: the test pushes output and exits it by hand. */
function fakePty() {
  let onData: ((d: string) => void) | undefined;
  let onExit: ((e: { exitCode: number }) => void) | undefined;
  const pty: PtyLike & { killed: boolean } = {
    killed: false,
    onData(cb) { onData = cb; },
    onExit(cb) { onExit = cb; },
    kill() {
      if (pty.killed) return;
      pty.killed = true;
      onExit?.({ exitCode: 137 });
    },
  };
  const calls: { file: string; args: string[]; opts: Parameters<SpawnPty>[2] }[] = [];
  const spawn: SpawnPty = (file, args, opts) => {
    calls.push({ file, args, opts });
    return pty;
  };
  return { pty, spawn, calls, out: (d: string) => onData?.(d), exit: (code: number) => onExit?.({ exitCode: code }) };
}

const CLAUDE = '/Users/me/.local/bin/claude';
const resolve = async () => CLAUDE;

/** Starts a capture and waits until its pty is spawned (the path resolves first). */
async function run(f: ReturnType<typeof fakePty>, extra: Partial<Parameters<typeof captureSetupToken>[0]> = {}) {
  const phases: string[] = [];
  const save = vi.fn(async (_t: string) => {});
  const ac = new AbortController();
  const p = captureSetupToken({ onPhase: (ph) => phases.push(ph), signal: ac.signal, spawn: f.spawn, save, resolve, ...extra });
  for (let i = 0; i < 20 && !f.calls.length; i++) await Promise.resolve();
  return { p, phases, save, ac };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('extractToken', () => {
  it('finds the token once something that is not a token char follows it', () => {
    expect(extractToken(`Your token:\r\n${TOKEN}\r\nStore it`)).toBe(TOKEN);
  });

  it('a token still streaming in (nothing after it yet) is not taken', () => {
    expect(extractToken(`Your token:\r\n${TOKEN}`)).toBeNull();
    expect(extractToken(`Your token:\r\n${TOKEN}`, { final: true })).toBe(TOKEN);
  });

  it('strips colour and OSC codes inside and around the token', () => {
    const half = TOKEN.length / 2;
    const painted = `\x1b]8;;x\x07\x1b[1m${TOKEN.slice(0, half)}\x1b[22m\x1b[36m${TOKEN.slice(half)}\x1b[0m\r\n`;
    expect(extractToken(painted)).toBe(TOKEN);
  });

  it('a cursor-forward after the token is a gap, not part of it', () => {
    expect(extractToken(`${TOKEN}\x1b[1CStore\x1b[1Cit`)).toBe(TOKEN);
  });

  it('a short or foreign string is no token', () => {
    expect(extractToken('sk-ant-oat01-short\n', { final: true })).toBeNull();
    expect(extractToken(`sk-ant-api03-${'a'.repeat(40)}\n`, { final: true })).toBeNull();
  });
});

describe('captureSetupToken', () => {
  it('runs the resolved claude directly (no shell) in a wide pty, with an allowlisted env', async () => {
    const f = fakePty();
    process.env.STRADO_AGENT_TOKEN = 'agent-secret';
    try {
      const { p } = await run(f);
      f.out(`${TOKEN}\n`);
      await p;
    } finally {
      delete process.env.STRADO_AGENT_TOKEN;
    }
    const c = f.calls[0]!;
    expect(c.file).toBe(CLAUDE);
    expect(c.args).toEqual(['setup-token']);
    expect(c.opts.cols).toBe(1000);
    expect(c.opts.env.STRADO_AGENT_TOKEN).toBeUndefined();
    expect(c.opts.env.PATH).toBe(process.env.PATH);
  });

  it('happy path: phases in order, the token saved, the pty ended', async () => {
    const f = fakePty();
    const { p, phases, save } = await run(f);
    expect(phases).toEqual(['opening-browser']);
    f.out('\x1b[2K·\x1b[1COpening\x1b[1Cbrowser\x1b[1Cto\x1b[1Csign\x1b[1Cin…');
    expect(phases).toEqual(['opening-browser', 'waiting-approval']);
    f.out(`\r\n✓ Long-lived authentication token created\r\n${TOKEN.slice(0, 30)}`);
    expect(save).not.toHaveBeenCalled();
    f.out(`${TOKEN.slice(30)}\r\nStore this token securely`);
    await p;
    expect(save).toHaveBeenCalledWith(TOKEN);
    expect(phases).toEqual(['opening-browser', 'waiting-approval', 'saving']);
    expect(f.pty.killed).toBe(true);
  });

  it('the token as the last output before a clean exit is still taken', async () => {
    const f = fakePty();
    const { p, save } = await run(f);
    f.out(TOKEN);
    f.exit(0);
    await p;
    expect(save).toHaveBeenCalledWith(TOKEN);
  });

  it('exit without a token → fixed error, nothing saved', async () => {
    const f = fakePty();
    const { p, save } = await run(f);
    f.out('Error: something went wrong with sk-ant-oat01-short\r\n');
    f.exit(1);
    await expect(p).rejects.toThrow('Claude sign-in finished without a token');
    expect(save).not.toHaveBeenCalled();
  });

  it('cancel kills the pty → fixed error, nothing saved', async () => {
    const f = fakePty();
    const { p, save, ac } = await run(f);
    f.out('Opening browser');
    ac.abort();
    await expect(p).rejects.toThrow('Claude sign-in cancelled');
    expect(f.pty.killed).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('an already-aborted signal never spawns', async () => {
    const f = fakePty();
    const ac = new AbortController();
    ac.abort();
    await expect(captureSetupToken({ onPhase: () => {}, signal: ac.signal, spawn: f.spawn, save: vi.fn(), resolve })).rejects.toThrow('Claude sign-in cancelled');
    expect(f.calls).toHaveLength(0);
  });

  it('10 minutes without approval → timed out, pty killed', async () => {
    vi.useFakeTimers();
    const f = fakePty();
    const { p, save } = await run(f);
    const caught = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((await caught as Error).message).toBe('Claude sign-in timed out');
    expect(f.pty.killed).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('a spawn failure → fixed error', async () => {
    const spawn: SpawnPty = () => { throw new Error(`posix_spawnp failed ${TOKEN}`); };
    await expect(captureSetupToken({ onPhase: () => {}, signal: new AbortController().signal, spawn, save: vi.fn(), resolve }))
      .rejects.toThrow(/^could not start claude setup-token$/);
  });

  it('a save failure → fixed error that carries no token', async () => {
    const f = fakePty();
    const { p } = await run(f, { save: async () => { throw new Error(`EACCES writing ${TOKEN}`); } });
    f.out(`${TOKEN}\n`);
    const err = await p.catch((e: Error) => e);
    expect((err as Error).message).toBe('could not save the Claude token');
  });

  it('nothing the pty prints reaches the console or stderr', async () => {
    const spies = [
      vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'),
      vi.spyOn(process.stderr, 'write'), vi.spyOn(process.stdout, 'write'),
    ];
    const f = fakePty();
    const { p, phases } = await run(f);
    f.out(`Opening browser\r\n${TOKEN}\r\n`);
    await p;
    for (const s of spies) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain('sk-ant-oat01');
    expect(JSON.stringify(phases)).not.toContain('sk-ant');
  });
});

describe('captureSetupToken: finding claude', () => {
  it('no claude on the login PATH → a fixed error, nothing spawned', async () => {
    const f = fakePty();
    await expect(captureSetupToken({ onPhase: () => {}, signal: new AbortController().signal, spawn: f.spawn, save: vi.fn(), resolve: async () => null }))
      .rejects.toThrow(/^Claude Code is not installed on this Mac$/);
    expect(f.calls).toHaveLength(0);
  });

  it('every error it can raise is in SETUP_TOKEN_ERRORS', () => {
    expect([...SETUP_TOKEN_ERRORS].sort()).toEqual([
      'Claude Code is not installed on this Mac', 'Claude sign-in cancelled', 'Claude sign-in finished without a token',
      'Claude sign-in timed out', 'could not save the Claude token', 'could not start claude setup-token',
    ]);
  });
});

describe('createSharedCapture', () => {
  function gate() {
    let phase: ((p: 'opening-browser' | 'waiting-approval' | 'saving') => void) | undefined;
    let finish!: (err?: Error) => void;
    let signal!: AbortSignal;
    const capture = vi.fn((opts: { onPhase(p: 'opening-browser' | 'waiting-approval' | 'saving'): void; signal: AbortSignal }) => {
      phase = opts.onPhase;
      signal = opts.signal;
      opts.onPhase('opening-browser');
      return new Promise<void>((res, rej) => {
        finish = (err) => (err ? rej(err) : res());
        opts.signal.addEventListener('abort', () => rej(new Error('Claude sign-in cancelled')));
      });
    });
    return { capture, phase: (p: 'waiting-approval' | 'saving') => phase!(p), finish: (e?: Error) => finish(e), signal: () => signal };
  }

  it('two runners connecting at once share one capture; both see every phase, the first one replayed', async () => {
    const g = gate();
    const shared = createSharedCapture(g.capture);
    const a: string[] = [];
    const b: string[] = [];
    const pa = shared({ onPhase: (p) => a.push(p), signal: new AbortController().signal });
    const pb = shared({ onPhase: (p) => b.push(p), signal: new AbortController().signal });
    g.phase('waiting-approval');
    g.finish();
    await Promise.all([pa, pb]);
    expect(g.capture).toHaveBeenCalledTimes(1);
    expect(a).toEqual(['opening-browser', 'waiting-approval']);
    expect(b).toEqual(['opening-browser', 'waiting-approval']);
  });

  it('one waiter cancelling leaves the capture running for the other; the last cancel ends it', async () => {
    const g = gate();
    const shared = createSharedCapture(g.capture);
    const ca = new AbortController();
    const cb = new AbortController();
    const pa = shared({ onPhase: () => {}, signal: ca.signal });
    const pb = shared({ onPhase: () => {}, signal: cb.signal });
    ca.abort();
    await expect(pa).rejects.toThrow('Claude sign-in cancelled');
    expect(g.signal().aborted).toBe(false);
    cb.abort();
    await expect(pb).rejects.toThrow('Claude sign-in cancelled');
    expect(g.signal().aborted).toBe(true);
  });

  it('a new connect after one finished starts a fresh capture', async () => {
    const g = gate();
    const shared = createSharedCapture(g.capture);
    const p1 = shared({ onPhase: () => {}, signal: new AbortController().signal });
    g.finish(new Error('Claude sign-in timed out'));
    await expect(p1).rejects.toThrow('Claude sign-in timed out');
    void shared({ onPhase: () => {}, signal: new AbortController().signal }).catch(() => {});
    expect(g.capture).toHaveBeenCalledTimes(2);
  });
});
