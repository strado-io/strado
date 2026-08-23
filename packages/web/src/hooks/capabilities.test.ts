import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPABILITIES, fetchCapabilities } from './capabilities';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(res: { ok?: boolean; json?: unknown } | Error) {
  vi.stubGlobal('fetch', async () => {
    if (res instanceof Error) throw res;
    return { ok: res.ok ?? true, json: async () => res.json } as unknown as Response;
  });
}

describe('fetchCapabilities', () => {
  it('reads what the server reports', async () => {
    mockFetch({ json: { embeds: false, notifications: false, runner: true, profile: 'dev' } });
    await expect(fetchCapabilities()).resolves.toEqual({
      embeds: false,
      notifications: false,
      runner: true,
      profile: 'dev',
    });
  });

  it('assumes embeds are available when the endpoint is missing', async () => {
    // An older server has no /api/capabilities. Hiding VS Code and Browser
    // from every existing install during the upgrade window would be a far
    // worse failure than briefly offering a tab a runner cannot honour.
    mockFetch({ ok: false });
    await expect(fetchCapabilities()).resolves.toEqual(DEFAULT_CAPABILITIES);
    expect(DEFAULT_CAPABILITIES.embeds).toBe(true);
  });

  it('falls back on a network error rather than throwing into render', async () => {
    mockFetch(new Error('offline'));
    await expect(fetchCapabilities()).resolves.toEqual(DEFAULT_CAPABILITIES);
  });

  it('fills in fields an older or partial response omits', async () => {
    mockFetch({ json: { embeds: false } });
    await expect(fetchCapabilities()).resolves.toEqual({
      embeds: false,
      notifications: true,
      runner: false,
      profile: 'stable',
    });
  });

  it('treats an unexpected profile value as stable rather than passing it through', async () => {
    mockFetch({ json: { profile: 'bogus' } });
    await expect(fetchCapabilities()).resolves.toMatchObject({ profile: 'stable' });
  });
});
