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

/** The image's unprivileged user: node:bookworm ships `node` as uid/gid 1000
 * and the Dockerfile runs as it. Every mapping below targets this pair. */
const IMAGE_UID = 1000;
const IMAGE_GID = 1000;
const IMAGE_HOME = '/home/node';

/** One named volume for every sandbox's HOME. Agent CLIs keep their login,
 * onboarding state and settings under ~ — with a fresh HOME per container
 * each worktree re-ran onboarding and asked to log in again, and `rm` on
 * delete threw the login away. Shared across worktrees on purpose: that is
 * exactly how several agent sessions on one desktop already behave. */
export const HOME_VOLUME = 'strado-sandbox-home';

export function createSandboxService(
  rt: SandboxRuntime,
  opts: {
    stateDir: string;
    exec?: ExecFn;
    /** The host user the runner runs as. A seam for the tests; defaults to this process. */
    ids?: { uid: number; gid: number };
  },
) {
  const exec = opts.exec ?? realExec;
  const envDir = path.join(opts.stateDir, 'sandboxes');
  const containerName = (slug: string) => `strado-sbx-${slug}`;
  const ids = opts.ids ?? { uid: process.getuid?.() ?? IMAGE_UID, gid: process.getgid?.() ?? IMAGE_GID };

  /**
   * How the container's `node` user lines up with the host user, so files
   * written in the bind-mounted worktree come out owned by the runner user
   * and the 0600 hook socket is readable inside. uid 1000 was assumed before;
   * a second user or a dedicated service account got a read-only worktree.
   *
   * podman (rootless): map the host user onto uid 1000 inside. Plain keep-id
   * when the host user IS 1000 (works on every podman); the `uid=` form
   * otherwise (podman ≥ 4.3 — older ones refuse it loudly at create, which
   * beats silently wrong ownership).
   * docker: no user namespace; run as the host uid/gid directly.
   */
  const userArgs = (): string[] => {
    if (rt.bin === 'podman') {
      return ids.uid === IMAGE_UID && ids.gid === IMAGE_GID
        ? ['--userns=keep-id']
        : [`--userns=keep-id:uid=${IMAGE_UID},gid=${IMAGE_GID}`];
    }
    return ['--user', `${ids.uid}:${ids.gid}`];
  };

  /**
   * The HOME volume exists and is writable by the user the container runs as.
   * A fresh named volume is populated from the image's /home/node (owned by
   * 1000) on first mount, which is right for podman's mapping; docker running
   * as a host uid other than 1000 needs it chowned once.
   */
  async function ensureHomeVolume(image: string): Promise<void> {
    const probe = await exec(rt.bin, ['volume', 'inspect', HOME_VOLUME]);
    if (probe.code === 0) return;
    const created = await exec(rt.bin, ['volume', 'create', HOME_VOLUME]);
    if (created.code !== 0) throw new Error(`sandbox home volume create failed: ${created.stderr.slice(-2000)}`);
    if (rt.bin === 'docker' && (ids.uid !== IMAGE_UID || ids.gid !== IMAGE_GID)) {
      const chown = await exec(
        rt.bin,
        ['run', '--rm', '--user', '0:0', '-v', `${HOME_VOLUME}:${IMAGE_HOME}`, image, 'chown', '-R', `${ids.uid}:${ids.gid}`, IMAGE_HOME],
        2 * 60_000,
      );
      if (chown.code !== 0) throw new Error(`sandbox home volume chown failed: ${chown.stderr.slice(-2000)}`);
    }
  }

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
      await ensureHomeVolume(c.image);
      const args = ['create', '--name', containerName(c.slug), '--label', `io.strado.worktree=${c.worktreePath}`];
      args.push(...userArgs());
      // HOME explicitly: under a user mapping the runtime synthesises a passwd
      // entry whose home may be the HOST path, which does not exist inside.
      args.push('--env', `HOME=${IMAGE_HOME}`, '-v', `${HOME_VOLUME}:${IMAGE_HOME}`);
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
      if (c.socketPath) {
        // The directory, never the file: a bind-mounted socket FILE pins its
        // inode, and the host recreates the socket on every restart, so a
        // running container would be left posting into a dead socket until it
        // was restarted. The directory must hold only the socket (it is all
        // visible inside) and the basename must match the in-container path.
        if (path.basename(c.socketPath) !== 'api.sock') {
          throw new Error(`sandbox socket must be named api.sock (got ${c.socketPath})`);
        }
        args.push('-v', `${path.dirname(c.socketPath)}:/run/strado`);
      }
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
