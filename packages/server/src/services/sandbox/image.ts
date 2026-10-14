import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ExecFn, type SandboxRuntime, realExec } from './runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** assets/ ships beside dist in packaged builds, same convention as hooks/. */
export function dockerfilePath(): string {
  if (process.env.STRADO_SANDBOX_ASSETS) return path.join(process.env.STRADO_SANDBOX_ASSETS, 'Dockerfile');
  return path.resolve(here, '../../../assets/sandbox/Dockerfile');
}

// -v4: GitHub App askpass refreshes repository tokens through the scoped host
// broker. v3 added uid-1000 keep-id + system safe.directory.
export function imageTag(nodeMajor: string | null): string {
  return nodeMajor ? `strado-sandbox:node${nodeMajor}-v4` : 'strado-sandbox:base-v4';
}

// Builds in flight, by tag. Two worktrees created before the image exists
// both pass the inspect probe; without this they both run `build`, doubling
// a 10-minute job and racing on the tag.
const building = new Map<string, Promise<string>>();

export async function ensureBaseImage(
  rt: SandboxRuntime,
  opts: { node: string | null },
  exec: ExecFn = realExec,
  /** Build output, one line at a time, so a first build is not a silent wait. */
  onLine?: (line: string) => void,
): Promise<string> {
  const tag = imageTag(opts.node);
  const probe = await exec(rt.bin, ['image', 'inspect', tag]);
  if (probe.code === 0) return tag;
  const inFlight = building.get(tag);
  if (inFlight) {
    onLine?.('waiting for a build already in progress');
    return inFlight;
  }
  const run = (async () => {
    const args = ['build', '-t', tag, '-f', dockerfilePath()];
    if (opts.node) args.push('--build-arg', `NODE_MAJOR=${opts.node}`);
    args.push(path.dirname(dockerfilePath()));
    let partial = '';
    const emit = (chunk: string) => {
      partial += chunk;
      let nl = partial.indexOf('\n');
      while (nl !== -1) {
        const line = partial.slice(0, nl).trim();
        partial = partial.slice(nl + 1);
        if (line) onLine?.(line);
        nl = partial.indexOf('\n');
      }
    };
    // 20 min: a first build pulls node:<major>-bookworm and `npm i -g` four
    // agent CLIs. The default 10s exec budget kills it (verified on a real
    // runner — the container never appears and the worktree degrades silently).
    const build = await exec(rt.bin, args, 20 * 60_000, onLine ? emit : undefined);
    if (build.code !== 0) throw new Error(`sandbox image build failed: ${build.stderr.slice(-2000)}`);
    return tag;
  })();
  building.set(tag, run);
  try {
    return await run;
  } finally {
    building.delete(tag);
  }
}
