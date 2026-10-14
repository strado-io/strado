import { describe, it, expect } from 'vitest';
import { SANDBOX_DEV_PID_FILE, SANDBOX_SOCKET_PATH, sandboxBuildSpec, sandboxProcessWrapper, sandboxSpecWrapper } from './spec.js';

const inner = () => ({ file: '/bin/zsh', args: ['-l', '-c', 'claude'] });

describe('sandboxBuildSpec', () => {
  it('passes through untouched when the worktree is not sandboxed', () => {
    const spec = sandboxBuildSpec({ rt: { bin: 'podman' }, isSandboxed: () => null, inner })('/w');
    expect(spec).toEqual(inner());
  });

  it('wraps into start-then-exec for a sandboxed worktree', () => {
    const spec = sandboxBuildSpec({ rt: { bin: 'podman' }, isSandboxed: () => 'feat-x', inner })('/w');
    expect(spec.file).toBe('/bin/sh');
    const script = spec.args[spec.args.length - 1]!;
    // idempotent start (resume-on-attach for a parked sandbox), then exec
    expect(script).toContain('podman start strado-sbx-feat-x');
    expect(script).toContain('exec podman exec -it');
    // session identity forwarded INTO the container: --env KEY copies the
    // value from the podman client process env, which sessionEnv populated
    for (const k of ['STRADO_SESSION_ID', 'STRADO_SESSION_MODE', 'STRADO_WORKTREE', 'STRADO_STATUS_PORT', 'STRADO_SERVER', 'STRADO_SERVER_SOCKET', 'STRADO_AGENT_BIN_DIR', 'STRADO_SHELL_BOOTSTRAP', 'STRADO_CLAUDE_HOOK', 'STRADO_AGENT_ID', 'STRADO_SCOPE_ID', 'STRADO_AGENT_TOKEN']) {
      expect(script).toContain(`--env ${k}`);
    }
    expect(script).toContain('--env STRADO_INNER_SHELL=/bin/bash');
    // shell-quoted: a worktree path can contain spaces (the brief's `-w /w`
    // spelling predates the quoting its own implementation does)
    expect(script).toContain(`-w '/w'`);
    // the inner command runs inside, quoted
    expect(script).toContain('claude');
  });

  it("drops start's stdout but leaves its stderr on the pty", () => {
    const spec = sandboxBuildSpec({ rt: { bin: 'podman' }, isSandboxed: () => 'feat-x', inner })('/w');
    const script = spec.args[spec.args.length - 1]!;
    // the container id start echoes is noise in the user's terminal...
    expect(script).toContain('start strado-sbx-feat-x >/dev/null;');
    // ...but a resume that FAILS (a port no longer free after parking, a
    // removed container) has to be readable, or the session dies with an
    // empty screen and nothing to debug
    expect(script).not.toContain('2>&1');
  });

  it('uses the configured runtime binary', () => {
    const spec = sandboxBuildSpec({ rt: { bin: 'docker' }, isSandboxed: () => 'feat-x', inner })('/w');
    const script = spec.args[spec.args.length - 1]!;
    expect(script).toContain('docker start strado-sbx-feat-x');
    expect(script).toContain('exec docker exec -it');
    expect(script).not.toContain('podman');
  });

  it('sets STRADO_SERVER_SOCKET in the client env so --env forwards it, and only here', () => {
    const spec = sandboxBuildSpec({ rt: { bin: 'podman' }, isSandboxed: () => 'feat-x', inner })('/w');
    const script = spec.args[spec.args.length - 1]!;
    // the wrapper itself defines the var: an unsandboxed session's env is
    // never touched, so the contract cannot leak onto the host
    expect(script).toContain(`STRADO_SERVER_SOCKET='${SANDBOX_SOCKET_PATH}'`);
    expect(script).toContain('export STRADO_SERVER_SOCKET');
    // ...and the export happens before the exec that forwards it
    expect(script.indexOf('export STRADO_SERVER_SOCKET')).toBeLessThan(script.indexOf('exec podman exec'));
  });

  it('substitutes the container shell for the host shell but keeps the command verbatim', () => {
    const spec = sandboxBuildSpec({
      rt: { bin: 'podman' },
      isSandboxed: () => 'feat-x',
      inner: () => ({ file: '/opt/homebrew/bin/fish', args: ['-l', '-c', "codex resume --last || codex"] }),
    })('/w');
    const script = spec.args[spec.args.length - 1]!;
    // /opt/homebrew/bin/fish does not exist in the image; bash does
    expect(script).not.toContain('/opt/homebrew/bin/fish');
    expect(script).toContain(`'bash' '-l' '-c' 'codex resume --last || codex'`);
  });

  it('keeps an interactive shell interactive (no -c to lift)', () => {
    const spec = sandboxBuildSpec({
      rt: { bin: 'podman' },
      isSandboxed: () => 'feat-x',
      inner: () => ({ file: '/bin/zsh', args: ['-il'] }),
    })('/w');
    const script = spec.args[spec.args.length - 1]!;
    expect(script).toContain(`'bash' '-il'`);
    // NOT the naive last-arg lift, which would run `bash -l -c '-il'`
    expect(script).not.toContain(`'-c' '-il'`);
  });

  it('runs a non-shell program verbatim rather than guessing at its argv', () => {
    const spec = sandboxBuildSpec({
      rt: { bin: 'podman' },
      isSandboxed: () => 'feat-x',
      inner: () => ({ file: 'node', args: ['server.js', '--port', '3000'] }),
    })('/w');
    const script = spec.args[spec.args.length - 1]!;
    expect(script).toContain(`'node' 'server.js' '--port' '3000'`);
  });

  it('shell-quotes the worktree path and the inner command', () => {
    const spec = sandboxBuildSpec({
      rt: { bin: 'podman' },
      isSandboxed: () => 'feat-x',
      inner: () => ({ file: '/bin/bash', args: ['-l', '-c', "echo 'hi there'"] }),
    })("/w/it's here");
    const script = spec.args[spec.args.length - 1]!;
    expect(script).toContain(`-w '/w/it'\\''s here'`);
    expect(script).toContain(`'echo '\\''hi there'\\'''`);
  });

  it('asks the lookup about the spawn cwd, not the worktree root it guesses', () => {
    const seen: string[] = [];
    sandboxBuildSpec({
      rt: { bin: 'podman' },
      isSandboxed: (cwd) => {
        seen.push(cwd);
        return null;
      },
      inner,
    })('/w/apps/web');
    expect(seen).toEqual(['/w/apps/web']);
  });
});

describe('sandboxSpecWrapper', () => {
  const wrap = sandboxSpecWrapper({ rt: { bin: 'podman' }, isSandboxed: (cwd) => (cwd === '/w' ? 'feat-x' : null) });

  it('wraps an override spec the manager already resolved', () => {
    const spec = wrap('/w', { file: '/bin/zsh', args: ['-il'] });
    expect(spec.file).toBe('/bin/sh');
    expect(spec.args[spec.args.length - 1]!).toContain(`'bash' '-il'`);
  });

  it('returns an override untouched outside a sandbox', () => {
    const override = { file: '/bin/zsh', args: ['-il'] };
    expect(wrap('/elsewhere', override)).toEqual(override);
  });
});

describe('sandboxProcessWrapper', () => {
  const calls: string[][] = [];
  const exec = async (_f: string, args: string[]) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const pw = sandboxProcessWrapper({ rt: { bin: 'podman' }, isSandboxed: (cwd) => (cwd === '/w' ? 'feat-x' : null), exec });

  it('execs the start command into the container, forwarding the spawn env by name, with a pid file', () => {
    const spec = pw.wrap('/w', { file: '/bin/zsh', args: ['-ilc', 'npm run dev'] }, ['PORT', 'API_URL', 'bad key']);
    expect(spec.file).toBe('/bin/sh');
    const script = spec.args[spec.args.length - 1]!;
    // -i, never -t: the process manager has no terminal, and `exec -t`
    // without one is refused.
    expect(script).toContain('podman exec -i ');
    expect(script).not.toContain('exec -it');
    expect(script).toContain('--env PORT --env API_URL');
    expect(script).not.toContain('bad key');
    expect(script).toContain(`sh -c 'echo $$ > ${SANDBOX_DEV_PID_FILE}; exec '\\''bash'\\'' '\\''-ilc'\\'' '\\''npm run dev'\\'''`);
    expect(script).toContain('-w \'/w\' strado-sbx-feat-x');
  });

  it('leaves an unsandboxed worktree alone and has nothing to stop there', async () => {
    const inner = { file: '/bin/zsh', args: ['-ilc', 'npm run dev'] };
    expect(pw.wrap('/elsewhere', inner, ['PORT'])).toEqual(inner);
    calls.length = 0;
    await pw.stopInside('/elsewhere');
    expect(calls).toEqual([]);
  });

  it('stops the recorded pid inside the container', async () => {
    calls.length = 0;
    await pw.stopInside('/w');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 4)).toEqual(['exec', 'strado-sbx-feat-x', 'sh', '-c']);
    expect(calls[0]![4]).toContain(`cat ${SANDBOX_DEV_PID_FILE}`);
    expect(calls[0]![4]).toContain('kill -TERM');
  });
});
