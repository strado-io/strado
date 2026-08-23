import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ExecFn, type SandboxRuntime, realExec } from './runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** assets/ ships beside dist in packaged builds, same convention as hooks/. */
export function dockerfilePath(): string {
  if (process.env.STRADO_SANDBOX_ASSETS) return path.join(process.env.STRADO_SANDBOX_ASSETS, 'Dockerfile');
  return path.resolve(here, '../../../assets/sandbox/Dockerfile');
}

// -v3: run as the base image's node user (uid 1000) so keep-id maps the
// bind-mounted worktree to the runner user; + system safe.directory.
export function imageTag(nodeMajor: string | null): string {
  return nodeMajor ? `strado-sandbox:node${nodeMajor}-v3` : 'strado-sandbox:base-v3';
}

export async function ensureBaseImage(
  rt: SandboxRuntime,
  opts: { node: string | null },
  exec: ExecFn = realExec,
): Promise<string> {
  const tag = imageTag(opts.node);
  const probe = await exec(rt.bin, ['image', 'inspect', tag]);
  if (probe.code === 0) return tag;
  const args = ['build', '-t', tag, '-f', dockerfilePath()];
  if (opts.node) args.push('--build-arg', `NODE_MAJOR=${opts.node}`);
  args.push(path.dirname(dockerfilePath()));
  // 20 min: a first build pulls node:<major>-bookworm and `npm i -g` three
  // agent CLIs. The default 10s exec budget kills it (verified on a real
  // runner — the container never appears and the worktree degrades silently).
  const build = await exec(rt.bin, args, 20 * 60_000);
  if (build.code !== 0) throw new Error(`sandbox image build failed: ${build.stderr.slice(-2000)}`);
  return tag;
}
