import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { stradoExtensionSource } from '../../src/services/vscodeExtensionInstall.js';

// The extension is plain CommonJS with no build step; its reporter is pure so
// it can be pinned here without a VS Code host.
const require = createRequire(import.meta.url);
const ext = require(`${stradoExtensionSource()}/extension.js`) as {
  createReporter(deps: {
    fetch: typeof fetch; pid: number; folder: () => string | null; server: string; intervalMs?: number;
    setInterval?: typeof setInterval; clearInterval?: typeof clearInterval;
  }): { start(): Promise<void>; stop(): Promise<void> };
  disableWorkspaceTrust(cfg: {
    inspect(): { globalValue?: boolean } | undefined;
    update(value: boolean): Promise<void>;
  }): Promise<boolean>;
};

describe('strado-window extension reporter', () => {
  it('announces its extension-host pid and folder to Strado, and withdraws on stop', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    const r = ext.createReporter({ fetch: fetchMock, pid: 4242, folder: () => '/wt/a', server: 'http://127.0.0.1:7777/', setInterval: (() => 0) as unknown as typeof setInterval, clearInterval: () => {} });
    await r.start();
    expect(calls[0].url).toBe('http://127.0.0.1:7777/api/vscode/window');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ pid: 4242, folder: '/wt/a' });
    await r.stop();
    expect(calls[1].init.method).toBe('DELETE');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ pid: 4242 });
  });

  it('stays quiet without a folder or a server, and swallows network errors', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const noFolder = ext.createReporter({ fetch: fetchMock, pid: 1, folder: () => null, server: 'http://x', setInterval: (() => 0) as unknown as typeof setInterval, clearInterval: () => {} });
    await noFolder.start();
    expect(fetchMock).not.toHaveBeenCalled();
    const failing = ext.createReporter({ fetch: fetchMock, pid: 1, folder: () => '/wt', server: 'http://x', setInterval: (() => 0) as unknown as typeof setInterval, clearInterval: () => {} });
    await expect(failing.start()).resolves.toBeUndefined();
  });

describe('strado-window turns off Restricted Mode for the embedded workbench', () => {
  it('sets security.workspace.trust.enabled=false once, when the user never chose', async () => {
    const update = vi.fn(async () => {});
    expect(await ext.disableWorkspaceTrust({ inspect: () => ({}), update })).toBe(true);
    expect(update).toHaveBeenCalledWith(false);
  });

  it('respects an explicit user choice either way', async () => {
    for (const globalValue of [true, false]) {
      const update = vi.fn(async () => {});
      expect(await ext.disableWorkspaceTrust({ inspect: () => ({ globalValue }), update })).toBe(false);
      expect(update).not.toHaveBeenCalled();
    }
  });

  it('never throws when the update is refused', async () => {
    const update = vi.fn(async () => { throw new Error('nope'); });
    expect(await ext.disableWorkspaceTrust({ inspect: () => ({}), update })).toBe(false);
  });
});
});
