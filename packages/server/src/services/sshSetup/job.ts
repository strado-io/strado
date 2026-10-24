import { AppError } from '../../errors.js';
import type { JobContext } from '../jobs.js';
import { stepReporter } from '../jobSteps.js';
import type { SpawnSpec, TerminalManager } from '../terminalManager.js';
import { isNewer } from '../version.js';
import type { SshHost } from './hosts.js';
import type { Destination, SshSession } from './session.js';
import {
  SSH_SETUP_KEY_PREFIX, SSH_SETUP_STEPS,
  type RemoteFacts, type SshSetupQuestion, type SshSetupResult,
} from './types.js';

// One "Add over SSH" run, start to finish: connect (pty), check, install,
// pair, service, podman, online. Exit codes come from the processes we spawn,
// never from parsing what the box prints. Every error is a fixed sentence: box
// output can carry anything, and the pair code must never ride along. Logins
// are not synced here: the first trust of a runner is the user's own click.

export type SetupDeps = {
  openSession(dest: Destination): Promise<SshSession>;
  terminal: Pick<TerminalManager, 'ensure' | 'onExit' | 'status' | 'kill'>;
  /** cwd for the setup pty. */
  home: string;
  apiUrl: string;
  cloud: {
    listRunnerIds(): Promise<string[]>;
    mintPairCode(): Promise<string>;
    isOnline(runnerId: string): Promise<boolean>;
  };
  /** The runner version the release feed offers, or null when unreachable. */
  feedVersion(): Promise<string | null>;
  probeScript: string;
  parseProbe(out: string): RemoteFacts;
  refusal(f: RemoteFacts): string | null;
  warnings(f: RemoteFacts): string[];
  podmanNeeded(f: RemoteFacts): boolean;
  podmanInstallCommand(f: RemoteFacts): string | null;
  recordHost(runnerId: string, host: SshHost): Promise<void>;
  sleep(ms: number): Promise<void>;
  pollTimeoutMs: number;
  pollIntervalMs: number;
};

const CANCELLED = 'setup cancelled';
const LINGER_COMMAND = 'loginctl enable-linger 2>/dev/null || sudo loginctl enable-linger "$(id -un)"';
const SEMVER = /^\d+\.\d+\.\d+$/;
const MIN_PAIR_VERSION = '0.1.32';
const TOO_OLD_TO_PAIR = "the runner on this box is older than 0.1.32 and can't pair over SSH — allow the upgrade and retry";
/** A hand-built "0.1.31-als" reads as 0.1.31. */
const tooOldToPair = (v: string) => isNewer(v, MIN_PAIR_VERSION);

/** The live handle the routes hold: answers questions, cancels the run. Q is
 *  the question minus its id; the frame's message is `message`, else q's own. */
export type SetupRun<Q extends object = Omit<SshSetupQuestion, 'id'>> = {
  signal: AbortSignal;
  ask(ctx: JobContext, q: Q, message?: string): Promise<boolean>;
  /** False when no such question is waiting. */
  answer(questionId: string, yes: boolean): boolean;
  cancel(): void;
};

export function createSetupRun<Q extends object = Omit<SshSetupQuestion, 'id'>>(cancelled = CANCELLED): SetupRun<Q> {
  const abort = new AbortController();
  const waiting = new Map<string, (yes: boolean) => void>();
  let n = 0;
  return {
    signal: abort.signal,
    ask(ctx, q, message) {
      const id = `q${++n}`;
      return untilCancelled(abort.signal, new Promise<boolean>((resolve) => {
        waiting.set(id, resolve);
        ctx.progress(message ?? (q as { message?: string }).message ?? '', { question: { id, ...q } });
      }), cancelled).finally(() => waiting.delete(id));
    },
    answer(questionId, yes) {
      const resolve = waiting.get(questionId);
      if (!resolve) return false;
      resolve(yes);
      return true;
    },
    cancel: () => abort.abort(),
  };
}

export function untilCancelled<T>(signal: AbortSignal, p: Promise<T>, cancelled = CANCELLED): Promise<T> {
  if (signal.aborted) return Promise.reject(new AppError('CONFLICT', cancelled));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AppError('CONFLICT', cancelled));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

const fail = (message: string) => new AppError('VALIDATION', message);

export async function runSshSetup(
  ctx: JobContext,
  input: { jobId: string; dest: Destination; name: string | null },
  deps: SetupDeps,
  run: SetupRun,
): Promise<SshSetupResult> {
  const key = `${SSH_SETUP_KEY_PREFIX}${input.jobId}`;
  const step = stepReporter(ctx, SSH_SETUP_STEPS);
  const guard = <T>(p: Promise<T>) => untilCancelled(run.signal, p);
  const warnings: string[] = [];
  let session: SshSession | null = null;

  /** An interactive step in the setup pty; resolves with its exit code. */
  const inTerminal = async (spec: SpawnSpec): Promise<number> => {
    await deps.terminal.ensure(key, deps.home, spec);
    let off = () => {};
    const code = new Promise<number>((resolve) => {
      off = deps.terminal.onExit(key, resolve);
      const now = deps.terminal.status(key);
      if (now.status === 'exited') resolve(now.exitCode ?? 1);
    });
    ctx.progress('Answer any questions in the terminal below.', { terminal: { key } });
    try {
      return await guard(code);
    } finally {
      off();
    }
  };

  try {
    step('connect');
    // Not guarded: a cancel mid-open must still land the session here, so the
    // finally closes it and removes its control dir.
    session = await deps.openSession(input.dest);
    if (run.signal.aborted) throw new AppError('CONFLICT', CANCELLED);
    if ((await inTerminal(session.connectSpec())) !== 0) throw fail('could not connect — check the destination and try again');

    step('check');
    // The probe reads the api base from stdin. Bounded: a wedged `podman info`
    // must not hold the run forever.
    const probed = await guard(session.run(deps.probeScript, `${deps.apiUrl}\n`, undefined, 30_000));
    if (probed.code !== 0) throw fail('could not check the machine');
    const facts = deps.parseProbe(probed.stdout);
    const refused = deps.refusal(facts);
    if (refused) throw fail(refused);
    warnings.push(...deps.warnings(facts));
    const paired = facts.runner.pairedRunnerId;
    const mine = await guard(deps.cloud.listRunnerIds());
    const needsPair = !(paired && mine.includes(paired));

    step('install');
    const feed = await guard(deps.feedVersion());
    const installed = facts.runner.version;
    // Installing what the feed serves can't help when that release itself
    // predates `pair --code -`: say so now, instead of installing it and then
    // asking for an upgrade that doesn't exist yet.
    if (needsPair && feed && tooOldToPair(feed) && (!installed || tooOldToPair(installed))) {
      throw fail(`the published runner (${feed}) can't pair over SSH yet — it needs runner 0.1.32 or newer`);
    }
    let installedVersion = installed;
    let install = true;
    if (installed && feed && installed === feed) {
      install = false;
      step.detail(`already on ${installed}`);
    } else if (installed && (!SEMVER.test(installed) || (feed !== null && isNewer(feed, installed)))) {
      install = await run.ask(ctx, {
        kind: 'overwrite-install',
        message: `This box runs strado-runner ${installed}${feed ? `, and the current release is ${feed}` : ''}. Replace it?${
          needsPair && tooOldToPair(installed) ? ' It is too old to pair over SSH without the upgrade.' : ''}`,
      });
      if (!install) step.detail(`keeping ${installed}`);
    } else if (installed && !feed) {
      install = false;
      step.detail(`release feed unreachable; keeping ${installed}`);
    }
    if (install) {
      const res = await guard(session.run(
        // The script installs from STRADO_API_URL: without it a dev or staging
        // api would fetch the script from itself but the runner from prod.
        'read api; curl -fsSL "$api/install-runner.sh" | STRADO_API_URL="$api" sh',
        `${deps.apiUrl}\n`,
        (line) => step.detail(line),
        10 * 60_000,
      ));
      if (res.code !== 0) throw fail('install failed — see the output above');
      installedVersion = feed;
    }
    const bin = `${facts.home}/.strado/runner/bin/strado-runner`;

    // `pair --code -` (code on stdin) arrived in 0.1.32; an older runner would
    // take "-" as the code.
    if (needsPair && installedVersion && tooOldToPair(installedVersion)) throw fail(TOO_OLD_TO_PAIR);

    step('pair');
    let runnerId: string;
    if (!needsPair) {
      runnerId = paired!;
      step.detail('already paired to your account');
    } else {
      let force = false;
      if (paired) {
        force = await run.ask(ctx, {
          kind: 'repair-other-account',
          message: 'This box is paired to another Strado account. Re-pair it to yours? Its stored logins are wiped.',
        });
        if (!force) throw fail('this box is paired to another account; left as it was');
      }
      const code = await guard(deps.cloud.mintPairCode());
      const argv = [bin, 'pair', '--code', '-', '--api', deps.apiUrl, ...(input.name ? ['--name', input.name] : []), ...(force ? ['--force'] : [])];
      const res = await guard(session.exec(argv, `${code}\n`, 60_000));
      const id = res.code === 0 ? /^runnerId=([A-Za-z0-9_-]{1,64})\s*$/m.exec(res.stdout)?.[1] : undefined;
      if (!id) throw fail('pairing failed on the box');
      runnerId = id;
    }

    step('service');
    if (!facts.systemdUser) {
      warnings.push('no systemd user session on this box: the runner will not survive logout or reboot');
    } else {
      const res = await guard(session.exec([bin, 'install-service'], undefined, 60_000));
      if (res.code !== 0) throw fail('could not install the runner service');
      if (facts.linger === false) {
        const yes = await run.ask(ctx, {
          kind: 'linger',
          message: 'Keep the runner running after you log out? This enables linger for your user, which may ask for your sudo password.',
          command: LINGER_COMMAND,
        });
        const ok = yes && (await inTerminal(session.ttySpec(LINGER_COMMAND))) === 0;
        if (!ok) warnings.push('linger is off: the runner stops when you log out of the box');
      }
    }

    step('podman');
    let sandboxes = true;
    if (deps.podmanNeeded(facts)) {
      const command = deps.podmanInstallCommand(facts);
      const yes = command !== null && await run.ask(ctx, {
        kind: 'podman',
        message: 'Sandboxes need podman 4.3 or newer on this box. Install it now? This runs with sudo.',
        command,
      });
      if (yes && (await inTerminal(session.ttySpec(command!))) === 0) {
        // The runner detects its container runtime once, at boot.
        await guard(session.run('systemctl --user restart strado-runner', undefined, undefined, 30_000));
      } else {
        sandboxes = false;
        warnings.push(command === null
          ? 'podman could not be installed automatically on this distro: sandboxes are off until you install podman 4.3+'
          : 'sandboxes are off: podman is not installed');
      }
    }

    step('online');
    const polls = Math.ceil(deps.pollTimeoutMs / deps.pollIntervalMs);
    for (let i = 0; ; i++) {
      if (await guard(deps.cloud.isOnline(runnerId))) break;
      if (i >= polls) {
        throw fail(`runner did not come online in 2 minutes — check: ssh ${input.dest.target} journalctl --user -u strado-runner -n 50`);
      }
      await guard(deps.sleep(deps.pollIntervalMs));
    }

    await deps.recordHost(runnerId, {
      target: input.dest.target,
      port: input.dest.port,
      addedAt: new Date().toISOString(),
      lastInstallVersion: installedVersion,
    });
    return { runnerId, name: input.name ?? facts.hostname, sandboxes, warnings };
  } finally {
    if (deps.terminal.status(key).status === 'running') deps.terminal.kill(key);
    await session?.close();
  }
}
