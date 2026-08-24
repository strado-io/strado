import { spawn } from 'node:child_process';
import type { EventBus } from '../events/bus.js';
import { checkTool, installSpec, type ToolStatus } from './toolCheck.js';

// Installing a prerequisite used to mean leaving the app: read the hint, find a
// terminal, run npm, come back, hit Re-check. This runs it in place and streams
// the output back, so onboarding never hands the user off mid-flow.
//
// Two rules hold this safe:
//   1. The client sends a tool id, never a command. The argv comes from
//      toolCheck's own TOOLS table (see installSpec).
//   2. spawn() with argv and no shell, so nothing is word-split or expanded.

export const INSTALL_CHANNEL = 'envInstall';

// npm fetching a global package over a slow link is minutes, not seconds; a
// wedged registry connection must still end rather than strand onboarding.
const TIMEOUT_MS = 5 * 60_000;

export type InstallEvent =
  | { type: 'output'; data: { id: string; line: string } }
  | { type: 'done'; data: { id: string; ok: boolean; message: string | null; tool: ToolStatus | null } };

type Running = { kill: () => void };

export type ToolInstaller = {
  /** Starts an install; returns false when one is already running for this id. */
  start(id: string): boolean;
  cancel(id: string): void;
  isRunning(id: string): boolean;
};

export function createToolInstaller(bus: EventBus): ToolInstaller {
  const running = new Map<string, Running>();

  const emit = (evt: InstallEvent) => bus.emit(INSTALL_CHANNEL, evt);

  return {
    isRunning: (id) => running.has(id),
    cancel(id) {
      running.get(id)?.kill();
    },
    start(id) {
      if (running.has(id)) return false;
      const spec = installSpec(id);
      if (!spec) return false;

      emit({ type: 'output', data: { id, line: `$ ${spec.display}` } });
      const child = spawn(spec.file, spec.args, {
        // No shell, and no inherited stdin: npm must never be able to sit on a
        // password or confirmation prompt we have no way to answer.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_yes: 'true' },
      });

      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, TIMEOUT_MS);

      running.set(id, {
        kill: () => {
          killed = true;
          child.kill('SIGKILL');
        },
      });

      // npm writes progress to stderr, so both streams are the same log here.
      // Partial chunks are buffered: a line split across two reads would
      // otherwise render as two half lines in the UI.
      const pump = (stream: NodeJS.ReadableStream) => {
        let rest = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          const parts = (rest + chunk).split(/\r?\n/);
          rest = parts.pop() ?? '';
          for (const line of parts) {
            const trimmed = line.trim();
            if (trimmed) emit({ type: 'output', data: { id, line: trimmed } });
          }
        });
        stream.on('end', () => {
          const trimmed = rest.trim();
          if (trimmed) emit({ type: 'output', data: { id, line: trimmed } });
        });
      };
      if (child.stdout) pump(child.stdout);
      if (child.stderr) pump(child.stderr);

      const finish = async (message: string | null) => {
        clearTimeout(timer);
        running.delete(id);
        // Re-probe rather than trusting the exit code: a zero exit whose binary
        // still isn't on PATH is a failed install as far as the user is
        // concerned, and that is exactly the EACCES-on-system-node case.
        const tool = message === null ? await checkTool(id) : null;
        const ok = tool?.found === true;
        emit({
          type: 'done',
          data: {
            id,
            ok,
            message: message ?? (ok ? null : `${spec.display} finished but ${id} still isn't on PATH.`),
            tool,
          },
        });
      };

      child.on('error', (err) => {
        void finish(`Could not run ${spec.file}: ${err.message}`);
      });
      child.on('close', (code) => {
        if (killed) return void finish(`${spec.display} was stopped.`);
        if (code === 0) return void finish(null);
        void finish(`${spec.display} exited with code ${code}.`);
      });
      return true;
    },
  };
}
