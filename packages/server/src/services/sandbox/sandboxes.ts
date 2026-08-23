import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type ExecFn, type SandboxRuntime, realExec } from './runtime.js';
import { gitMountPaths } from './bareRepo.js';

export type SandboxService = ReturnType<typeof createSandboxService>;

/**
 * The identity of a worktree's container and env file.
 *
 * NOT the worktree slug: that is built from ticket + title and is not
 * repo-scoped, so the same ticket worked in two repos yields the same slug —
 * while container names and env-file names are global to the machine. Two
 * repos would then share one container, and any `remove` would take out the
 * other repo's work. The worktree path is the one thing that is unique, so it
 * supplies the suffix.
 */
export function sandboxSlugFor(worktreeSlug: string, worktreePath: string): string {
  return `${worktreeSlug}-${createHash('sha256').update(worktreePath).digest('hex').slice(0, 8)}`;
}

export function createSandboxService(rt: SandboxRuntime, opts: { stateDir: string; exec?: ExecFn }) {
  const exec = opts.exec ?? realExec;
  const envDir = path.join(opts.stateDir, 'sandboxes');
  const containerName = (slug: string) => `strado-sbx-${slug}`;

  async function writeEnvFile(slug: string, env: Record<string, string>): Promise<string> {
    // Validate env keys and values to prevent injection attacks
    for (const [k, v] of Object.entries(env)) {
      if (/[=\s\n\r]/.test(k)) {
        throw new Error(`Invalid env key "${k}": must not contain =, whitespace, newlines, or carriage returns`);
      }
      if (/[\n\r]/.test(v)) {
        throw new Error(`Invalid env value for "${k}": must not contain newlines or carriage returns`);
      }
    }

    await fsp.mkdir(envDir, { recursive: true });
    const p = path.join(envDir, `${slug}.env`);
    // HOST=0.0.0.0: with bridge networking + a published port, a dev server
    // bound to loopback inside the container is unreachable from the host.
    // Most Node dev servers honor HOST; ones that don't need --host in their
    // start command (documented limitation, not a bug).
    const lines = Object.entries({ HOST: '0.0.0.0', ...env }).map(([k, v]) => `${k}=${v}`);
    await fsp.writeFile(p, lines.join('\n') + '\n', { mode: 0o600 });
    // Enforce mode 0o600 on overwrite: writeFile's mode option applies only at creation
    await fsp.chmod(p, 0o600);
    return p;
  }

  return {
    containerName,
    envFilePath: (slug: string) => path.join(envDir, `${slug}.env`),

    async create(c: { worktreePath: string; slug: string; image: string; port: number | null; env: Record<string, string>; socketPath: string | null; hooksPath: string | null }) {
      const envFile = await writeEnvFile(c.slug, c.env);
      const mounts = await gitMountPaths(c.worktreePath);
      const args = ['create', '--name', containerName(c.slug), '--label', `io.strado.worktree=${c.worktreePath}`];
      if (rt.bin === 'podman') args.push('--userns=keep-id'); // rootless: mounted worktree writable without chown
      for (const m of mounts) args.push('-v', `${m}:${m}`); // IDENTICAL paths — .git pointer files are absolute
      // The agent hook scripts. Claude's settings.local.json and codex's
      // `notify` flag both name the script by its HOST path, so this mount is
      // identical in and out like the git ones — and read-only: the container
      // has no business rewriting scripts that also run on the host. Skipped
      // when an existing mount already covers it (Strado developed inside its
      // own sandbox has hooks/ under the worktree; mounting it again would
      // shadow the live copy with a second view of itself).
      const hooks = c.hooksPath;
      if (hooks && !mounts.some((m) => hooks === m || hooks.startsWith(m + path.sep))) {
        args.push('-v', `${hooks}:${hooks}:ro`);
      }
      if (c.socketPath) args.push('-v', `${c.socketPath}:/run/strado/api.sock`);
      if (c.port != null) args.push('-p', `127.0.0.1:${c.port}:${c.port}`);
      args.push('--env-file', envFile, '-w', c.worktreePath, c.image, 'sleep', 'infinity');
      // 5 min, not the 10s default: the first keep-id create of a fresh image
      // does a one-time ownership copy-up of every image layer into the user
      // namespace, which runs well past 10s on a real runner. The container is
      // half-created when the timeout kills it, so the job errors while the
      // container lingers — verified on runner-dev. Later creates reuse the
      // cached mapping and finish in well under a second.
      const r = await exec(rt.bin, args, 5 * 60_000);
      if (r.code !== 0) throw new Error(`sandbox create failed: ${r.stderr.slice(-2000)}`);
    },

    async start(slug: string) {
      const r = await exec(rt.bin, ['start', containerName(slug)], 2 * 60_000);
      if (r.code !== 0) throw new Error(`sandbox start failed: ${r.stderr.slice(-2000)}`);
    },
    async stop(slug: string) { await exec(rt.bin, ['stop', '-t', '10', containerName(slug)], 30_000); },
    async remove(slug: string) { await exec(rt.bin, ['rm', '-f', containerName(slug)]); },

    /** Which worktree a container belongs to, from the label `create` set.
     * null when there is no such container, or when it carries no label of
     * ours — callers use this to refuse destructive ops on strangers. */
    async worktreeOf(slug: string): Promise<string | null> {
      // `inspect` needs no per-runtime format string, unlike listRunning's
      // `ps`: both podman and docker expose .Config.Labels on a container.
      const fmt = '{{index .Config.Labels "io.strado.worktree"}}';
      const r = await exec(rt.bin, ['inspect', '--format', fmt, containerName(slug)]);
      if (r.code !== 0) return null;
      const value = r.stdout.trim();
      // Go's text/template prints this for a missing map key.
      return value && value !== '<no value>' ? value : null;
    },

    async status(slug: string): Promise<'running' | 'stopped' | 'absent'> {
      const r = await exec(rt.bin, ['inspect', '--format', '{{.State.Status}}', containerName(slug)]);
      if (r.code !== 0) return 'absent';
      return r.stdout.trim() === 'running' ? 'running' : 'stopped';
    },

    async listRunning(): Promise<{ slug: string; worktreePath: string }[]> {
      // Format strings are runtime-specific:
      // - podman: {{index .Labels "key"}} extracts a single label value
      // - docker: {{.Label "key"}} extracts a single label value
      // Both emit NAME\tLABEL_VALUE, where paths may contain commas but not tabs.
      const fmt = rt.bin === 'podman' ? '{{.Names}}\t{{index .Labels "io.strado.worktree"}}' : '{{.Names}}\t{{.Label "io.strado.worktree"}}';
      const r = await exec(rt.bin, ['ps', '--filter', 'label=io.strado.worktree', '--format', fmt]);
      if (r.code !== 0) return [];
      return r.stdout.split('\n').filter(Boolean).flatMap((line) => {
        const parts = line.split('\t');
        const name = parts[0];
        const wt = parts[1];
        if (!name?.startsWith('strado-sbx-') || !wt) return [];
        return [{ slug: name.slice('strado-sbx-'.length), worktreePath: wt }];
      });
    },
  };
}
