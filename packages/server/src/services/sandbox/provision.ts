// Build and start a worktree's sandbox container.
//
// One function for two callers: the tail of a worktree create, and the
// explicit "rebuild sandbox" route for a worktree whose first build failed
// (or whose container was removed out of band). Before the route existed the
// only retry was deleting the worktree and starting over, and nothing in the
// UI said the worktree had quietly fallen back to running on the host.
import { AppError } from '../../errors.js';
import type { StepReporter } from '../jobSteps.js';
import { hooksDir } from '../claudeHooks.js';
import { githubProjectFromCloneUrl } from '../runnerGitCredential.js';
import { issueSandboxGitBrokerToken } from '../sandboxGitBroker.js';
import { detectSandboxManifest } from './detect.js';
import { ensureBaseImage } from './image.js';
import type { SandboxRuntime } from './runtime.js';
import { sandboxSlugFor, type SandboxService } from './sandboxes.js';

export type ProvisionDeps = {
  sandbox: SandboxService;
  sandboxRuntime: SandboxRuntime;
  sandboxSocketPath: string | null;
  sandboxSlugs: { set(worktreePath: string, slug: string): void };
  state: { patch(worktreePath: string, patch: { sandbox: { slug: string } | null }): Promise<unknown> };
  bus: { emit(channel: 'worktrees', event: { type: 'worktree.updated'; data: { path: string } }): void };
  log: (line: string) => void;
};

export type ProvisionInput = {
  worktreePath: string;
  /** The PROJECT dir (worktree + projectSubdir): where .nvmrc / engines live. */
  projectDir: string;
  /** The worktree slug (its directory name); container identity derives from it. */
  slug: string;
  port: number | null;
  cloneUrl: string | null;
  /** The user's credentials for the container, assembled on the desktop. */
  sandboxEnv: Record<string, string>;
  step: StepReporter;
};

/** Detects, builds, creates, starts; records the slug only once the container
 * is up. Returns the sandbox slug. Throws with the container and env file left
 * in place: they are the only evidence of why a build failed. */
export async function provisionSandbox(deps: ProvisionDeps, o: ProvisionInput): Promise<string> {
  const { sandbox, sandboxRuntime } = deps;
  o.step('sandbox-detect');
  // The PROJECT dir, not the worktree root: in a monorepo the root has no
  // .nvmrc or engines and the app subdir does, so reading the root builds
  // an image the project cannot run on.
  const manifest = await detectSandboxManifest(o.projectDir, o.worktreePath);

  o.step('sandbox-build');
  // Attached to the build step, which takes minutes — on the detect step
  // this would be on screen for the milliseconds detection takes. What we
  // detected has to be visible: "wrong node version" is the failure mode,
  // and guessing silently makes it unanswerable.
  o.step.detail(`sandbox: ${manifest.summary}`);
  deps.log(`sandbox detect ${o.worktreePath}: ${manifest.summary}`);
  // Container and env-file identity, which is NOT the worktree slug:
  // ticket+title repeats across repos, container names are global.
  const sandboxSlug = sandboxSlugFor(o.slug, o.worktreePath);
  try {
    // Build output goes to the step, throttled: podman's own STEP lines
    // always, anything else at most every 2s. A first build is minutes
    // of pulling and `npm i -g`; silence for that long reads as a hang.
    let lastDetailAt = 0;
    const onBuildLine = (line: string) => {
      const now = Date.now();
      if (!/^(STEP|\[\d+\/\d+\]|#\d+ )/.test(line) && now - lastDetailAt < 2000) return;
      lastDetailAt = now;
      o.step.detail(line.slice(0, 200));
    };
    const image = await ensureBaseImage(sandboxRuntime, { node: manifest.node }, undefined, onBuildLine);
    // A previous attempt that died after `create` left the container
    // behind (we never tear down on failure, by design), so a retry would
    // collide on the name. Remove it — but only after proving it is this
    // worktree's: `rm -f` on someone else's running container destroys
    // work, and a name is not proof. The label is.
    if ((await sandbox.status(sandboxSlug)) !== 'absent') {
      const owner = await sandbox.worktreeOf(sandboxSlug);
      if (owner !== o.worktreePath) {
        throw new AppError(
          'SANDBOX_CONFLICT',
          `container ${sandbox.containerName(sandboxSlug)} belongs to ${owner ?? 'an unlabelled worktree'}, not ${o.worktreePath} — refusing to remove it`,
        );
      }
      await sandbox.remove(sandboxSlug);
    }
    let sandboxEnv = { ...o.sandboxEnv };
    const github = o.cloneUrl ? githubProjectFromCloneUrl(o.cloneUrl) : null;
    if (github && deps.sandboxSocketPath && !sandboxEnv.GITHUB_TOKEN) {
      const brokerToken = await issueSandboxGitBrokerToken(o.worktreePath, github.projectPath);
      if (brokerToken) {
        sandboxEnv = {
          ...sandboxEnv,
          GIT_ASKPASS: '/usr/local/bin/strado-askpass',
          GIT_HTTP_USER: 'x-access-token',
          STRADO_GIT_BROKER_TOKEN: brokerToken,
        };
      }
    }
    await sandbox.create({
      worktreePath: o.worktreePath,
      slug: sandboxSlug,
      image,
      port: o.port,
      env: sandboxEnv,
      socketPath: deps.sandboxSocketPath,
      // The claude/codex hook scripts, mounted at the same absolute
      // path inside: installClaudeHooks writes the HOST path into the
      // worktree's settings, and the container runs that exact command.
      hooksPath: hooksDir(),
    });
    await sandbox.start(sandboxSlug);
    // Only now: the flag means "a container exists", and terminals are
    // routed into it on the strength of it.
    await deps.state.patch(o.worktreePath, { sandbox: { slug: sandboxSlug } });
    // The synchronous face of that flag, for terminal spawning. Written
    // beside the state patch and from the same value — never recomputed.
    deps.sandboxSlugs.set(o.worktreePath, sandboxSlug);
    deps.bus.emit('worktrees', { type: 'worktree.updated', data: { path: o.worktreePath } });
    return sandboxSlug;
  } catch (err) {
    // Deliberately no teardown: the half-built container and its env file
    // are the only evidence of WHY this failed. The worktree itself is
    // fine — it just runs unsandboxed until this is retried.
    deps.log(`sandbox build failed for ${o.worktreePath}: ${String(err)}`);
    throw err;
  }
}
