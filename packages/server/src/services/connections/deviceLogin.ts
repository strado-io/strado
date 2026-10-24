// Device-code logins on the runner (Codex; OpenCode's ChatGPT). The agent's
// own CLI runs in a one-shot container on the shared HOME volume, prints a
// verification URL and a user code, then blocks until the user approves in a
// browser on the laptop — or the code expires (15 min) and the hard kill ends
// it. Whatever it writes lands in the volume, where every sandbox sees it.
//
// The output is read only for the URL and the code; it never leaves this
// module. The URL must be OpenAI's: the laptop opens it, so box output must
// not be able to choose where the browser goes.
import { randomBytes } from 'node:crypto';
import { AppError } from '../../errors.js';
import { containerName, removeContainer, runOneShot, stripAnsi, type OneShotDeps } from './oneShot.js';
import type { DeviceLoginPrompt } from './types.js';

export type DeviceAgent = 'codex' | 'opencode';

/** The code lives 15 min; one more covers a slow approval near the end. */
export const DEVICE_LOGIN_TIMEOUT_MS = 16 * 60_000;
const CODE_TTL_MS = 15 * 60_000;
/** A finished login is kept this long for the laptop's last poll. */
const KEEP_DONE_MS = 30 * 60_000;

const COMMANDS: Record<DeviceAgent, string[]> = {
  codex: ['codex', 'login', '--device-auth'],
  // Both flags, always: without them opencode waits in a picker forever.
  opencode: ['opencode', 'auth', 'login', '-p', 'openai', '-m', 'ChatGPT Pro/Plus (headless)'],
};

const URL_RE = /https:\/\/auth\.openai\.com\/[A-Za-z0-9/_-]*/;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
const NOT_STARTED = 'device login did not start';

/** ended: we removed the container. Codex exits 0 on the SIGTERM that
 *  `rm -f` sends, so a run we ended is never ok, whatever its exit code. */
type Login = {
  agent: DeviceAgent;
  name: string;
  /** The runtime this login's container runs on, for removing it. */
  run: OneShotDeps;
  done: boolean;
  ok?: boolean;
  endedAt?: number;
  ended?: boolean;
};

export type DeviceLogins = {
  /** run: the runtime and image for this start (the image can change after
   *  the registry is made — a first sandbox builds it); defaults to deps. */
  start(agent: DeviceAgent, run?: OneShotDeps): Promise<DeviceLoginPrompt & { loginId: string }>;
  status(loginId: string): { done: boolean; ok?: boolean } | null;
  /** False when no such login is running. */
  cancel(loginId: string): Promise<boolean>;
};

export function createDeviceLogins(
  deps: OneShotDeps & {
    now?: () => number;
    startTimeoutMs?: number;
    /** Awaited before the login reads done: records it as Strado-managed. */
    onSuccess?: (agent: DeviceAgent) => Promise<void>;
  },
): DeviceLogins {
  const now = deps.now ?? Date.now;
  const startTimeoutMs = deps.startTimeoutMs ?? 2 * 60_000;
  const logins = new Map<string, Login>();

  const prune = () => {
    for (const [id, l] of logins) if (l.done && now() - (l.endedAt ?? 0) > KEEP_DONE_MS) logins.delete(id);
  };

  return {
    async start(agent, run = deps) {
      const cmd = COMMANDS[agent as DeviceAgent];
      if (!cmd) throw new AppError('VALIDATION', 'no device login for this agent');
      prune();
      // One at a time per agent: a retry replaces the run that is waiting.
      for (const l of logins.values()) {
        if (l.agent === agent && !l.done) {
          l.ended = true;
          await removeContainer(l.run, l.name);
        }
      }

      const loginId = randomBytes(16).toString('hex');
      const login: Login = { agent, name: containerName(), run, done: false };
      logins.set(loginId, login);

      return new Promise((resolve, reject) => {
        let buf = '';
        let settled = false;
        const fail = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          login.ended = true;
          void removeContainer(run, login.name);
          reject(new AppError('SHELL_FAILED', NOT_STARTED));
        };
        const timer = setTimeout(fail, startTimeoutMs);
        const onOutput = (chunk: string) => {
          if (settled) return;
          buf = (buf + chunk).slice(-64 * 1024);
          const text = stripAnsi(buf);
          const url = URL_RE.exec(text)?.[0];
          const code = CODE_RE.exec(text)?.[0];
          if (!url || !code) return;
          settled = true;
          clearTimeout(timer);
          buf = '';
          resolve({ loginId, url, code, expiresAt: now() + CODE_TTL_MS });
        };
        void runOneShot(run, { volume: true, cmd, timeoutMs: DEVICE_LOGIN_TIMEOUT_MS, onOutput, name: login.name })
          .then((r) => r.code, () => 1)
          .then(async (code) => {
            let ok = code === 0 && !login.ended;
            if (ok && deps.onSuccess) ok = await deps.onSuccess(agent).then(() => true, () => false);
            login.done = true;
            login.ok = ok;
            login.endedAt = now();
            fail();
          });
      });
    },

    status(loginId) {
      const l = logins.get(loginId);
      if (!l) return null;
      return l.done ? { done: true, ok: !!l.ok } : { done: false };
    },

    async cancel(loginId) {
      const l = logins.get(loginId);
      if (!l || l.done) return false;
      l.ended = true;
      await removeContainer(l.run, l.name);
      return true;
    },
  };
}
