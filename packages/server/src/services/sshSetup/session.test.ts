import fsp from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { openSession, parseDestination, shQuote, type ExecFn } from './session.js';

const SAFE = ['-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no'];

describe('parseDestination', () => {
  it.each([
    ['user@host', { target: 'user@host', port: null }],
    ['runner-dev', { target: 'runner-dev', port: null }],
    ['strado@192.168.1.7', { target: 'strado@192.168.1.7', port: null }],
    ['ssh://u@h:2222', { target: 'u@h', port: 2222 }],
    ['ssh://h', { target: 'h', port: null }],
    ['  u@h  ', { target: 'u@h', port: null }],
  ])('%s', (raw, want) => {
    expect(parseDestination(raw)).toEqual(want);
  });

  it.each([
    '-oProxyCommand=touch /tmp/x', '-p', 'u@h -oProxyCommand=x', 'u@h\tx', 'u@\nh', 'u@h\u0000', '', '   ',
    'ssh://u@h:0', 'ssh://u@h:70000', 'ssh://u@h:22x', 'ssh://-oProxyCommand=x', 'ssh://u@h/path', 'u@h;id', 'u@$(id)', 'u@`id`',
    `u@${'h'.repeat(300)}`,
  ])('refuses %j before anything spawns', (raw) => {
    expect(() => parseDestination(raw)).toThrow('not an ssh destination');
  });
});

describe('shQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shQuote("a'b c")).toBe(`'a'\\''b c'`);
    expect(shQuote('')).toBe("''");
  });
});

/** A fake ssh: records argv + stdin, answers `-G` OK and everything else from `reply`. */
function fakeExec(reply: (args: string[], stdin?: string) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: { file: string; args: string[]; stdin?: string }[] = [];
  const exec: ExecFn = vi.fn(async (file, args, opts) => {
    calls.push({ file, args, stdin: opts?.stdin });
    const r = args.includes('-G') ? { code: 0, stdout: 'hostname h\n' } : reply(args, opts?.stdin);
    if (r.stdout) opts?.onStdout?.(r.stdout);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  });
  return { exec, calls };
}

const afterDash = (args: string[]) => args.slice(args.indexOf('--') + 1);
const beforeDash = (args: string[]) => args.slice(0, args.indexOf('--'));

describe('openSession', () => {
  it('pre-checks with ssh -G, then makes a short 0700 control dir', async () => {
    const { exec, calls } = fakeExec();
    const s = await openSession({ target: 'u@h', port: 2222 }, { exec });
    expect(calls[0]!.file).toBe('ssh');
    expect(calls[0]!.args).toEqual(['-G', '-p', '2222', '--', 'u@h']);
    expect(s.controlDir.startsWith('/tmp/strado-ssh-')).toBe(true);
    expect(`${s.controlDir}/cm`.length).toBeLessThan(60);
    expect((await fsp.stat(s.controlDir)).mode & 0o777).toBe(0o700);
    await s.close();
  });

  it('an unresolvable destination is refused with a fixed message and no control dir', async () => {
    const exec: ExecFn = vi.fn(async () => ({ code: 255, stdout: '', stderr: 'bad' }));
    await expect(openSession({ target: 'nope', port: null }, { exec })).rejects.toThrow('ssh cannot resolve that destination');
  });

  it('connectSpec: the interactive master, mandatory flags, -- before the target', async () => {
    const { exec } = fakeExec();
    const s = await openSession({ target: 'u@h', port: 2222 }, { exec });
    const spec = s.connectSpec();
    expect(spec.file).toBe('ssh');
    expect(beforeDash(spec.args)).toEqual(expect.arrayContaining([...SAFE, 'ControlMaster=yes', `ControlPath=${s.controlDir}/cm`, 'ControlPersist=300', '-p', '2222']));
    expect(spec.args).not.toContain('BatchMode=yes');
    expect(afterDash(spec.args)).toEqual(['u@h', 'true']);
    expect(spec.args.join(' ')).not.toMatch(/StrictHostKeyChecking/);
    await s.close();
  });

  it('run: BatchMode over the master, the script as one quoted sh -c, stdin passed through', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0, stdout: 'k=v\n' }));
    const s = await openSession({ target: 'u@h', port: null }, { exec });
    const lines: string[] = [];
    const res = await s.run("echo 'hi'", 'param\n', (l) => lines.push(l));
    expect(res).toEqual({ code: 0, stdout: 'k=v\n', stderr: '' });
    const c = calls.at(-1)!;
    expect(beforeDash(c.args)).toEqual(expect.arrayContaining([...SAFE, 'ControlMaster=no', 'BatchMode=yes', `ControlPath=${s.controlDir}/cm`]));
    expect(afterDash(c.args)).toEqual(['u@h', `sh -c ${shQuote("echo 'hi'")}`]);
    expect(c.stdin).toBe('param\n');
    expect(lines).toEqual(['k=v']);
    await s.close();
  });

  it('exec: a remote argv, each word quoted', async () => {
    const { exec, calls } = fakeExec();
    const s = await openSession({ target: 'u@h', port: null }, { exec });
    await s.exec(['/home/u/.strado/runner/bin/strado-runner', 'pair', '--code', '-'], 'SECRET\n');
    const c = calls.at(-1)!;
    expect(afterDash(c.args)).toEqual(['u@h', `'/home/u/.strado/runner/bin/strado-runner' 'pair' '--code' '-'`]);
    expect(c.args.join(' ')).not.toContain('SECRET');
    await s.close();
  });

  it('ttySpec: -t over the master for a sudo step', async () => {
    const { exec } = fakeExec();
    const s = await openSession({ target: 'u@h', port: null }, { exec });
    const spec = s.ttySpec('sudo loginctl enable-linger "$(id -un)"');
    expect(beforeDash(spec.args)).toEqual(expect.arrayContaining([...SAFE, '-t', 'ControlMaster=no', `ControlPath=${s.controlDir}/cm`]));
    expect(afterDash(spec.args)).toEqual(['u@h', `sh -c ${shQuote('sudo loginctl enable-linger "$(id -un)"')}`]);
    await s.close();
  });

  it('close: ssh -O exit on the master, then the control dir is gone; twice is harmless', async () => {
    const { exec, calls } = fakeExec();
    const s = await openSession({ target: 'u@h', port: null }, { exec });
    await s.close();
    const exit = calls.at(-1)!;
    expect(exit.args).toEqual(expect.arrayContaining(['-O', 'exit', `ControlPath=${s.controlDir}/cm`]));
    expect(afterDash(exit.args)).toEqual(['u@h']);
    await expect(fsp.stat(s.controlDir)).rejects.toThrow();
    await s.close();
  });
});
