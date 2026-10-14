// Start/Stop of a dev server in a sandboxed worktree goes through the
// wrapper: the command is rewritten (exec into the container, env forwarded
// by name) and Stop reaches inside before signalling the host-side client.
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { createProcessManager } from './processManager.js';

describe('createProcessManager with a sandbox', () => {
  it('spawns the wrapped spec with the forwarded keys, and stops inside first', async () => {
    const seen: { cwd: string; keys: string[] }[] = [];
    const stopInside = vi.fn(async () => {});
    const proc = createProcessManager(createEventBus(), undefined, {
      wrap: (cwd, spec, keys) => {
        seen.push({ cwd, keys: keys ?? [] });
        // Stand-in for `podman exec …`: echo what we were asked to run, then wait.
        return { file: 'sh', args: ['-c', `echo wrapped:${spec.args.join(' ')} PORT=$PORT API=$API_URL; sleep 30`] };
      },
      stopInside,
    });
    await proc.start({ key: '/w', cwd: '/tmp', command: '/bin/zsh', args: ['-ilc', 'npm run dev'], env: { API_URL: 'x' }, port: 4321 });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([{ cwd: '/tmp', keys: ['API_URL', 'PORT'] }]);
    expect(proc.snapshot('/w').join('\n')).toContain('wrapped:-ilc npm run dev PORT=4321 API=x');
    await proc.stop('/w');
    expect(stopInside).toHaveBeenCalledWith('/tmp');
    expect(proc.isRunning('/w')).toBe(false);
  });
});
