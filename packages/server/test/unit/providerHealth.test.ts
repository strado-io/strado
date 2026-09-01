import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pullRequestsForBranch } from '../../src/services/github';
import { mergeRequestsForBranch } from '../../src/services/gitlab';
import { __resetProviderHealth } from '../../src/services/providerHealth';

beforeEach(() => __resetProviderHealth());
afterEach(() => vi.restoreAllMocks());

describe('unreachable-host breaker', () => {
  it('stops calling a GitHub host that just timed out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(pullRequestsForBranch('ghe.vpn.test', 't', 'o/a', 'b1', { force: true }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(pullRequestsForBranch('ghe.vpn.test', 't', 'o/a', 'b2'))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('VPN') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops calling a GitLab host that just timed out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(mergeRequestsForBranch('gl.vpn.test', 't', 'g/p', 'b1', { force: true }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(mergeRequestsForBranch('gl.vpn.test', 't', 'g/p', 'b2'))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps hosts independent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('down.test')) throw new DOMException('timed out', 'TimeoutError');
      return new Response('[]', { status: 200 });
    });

    await expect(pullRequestsForBranch('down.test', 't', 'o/a', 'b', { force: true })).rejects.toBeTruthy();
    await expect(pullRequestsForBranch('up.test', 't', 'o/a', 'b', { force: true })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets an explicit refresh probe a host inside its cooldown', async () => {
    let first = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (first) { first = false; throw new DOMException('timed out', 'TimeoutError'); }
      return new Response('[]', { status: 200 });
    });

    await expect(pullRequestsForBranch('flap.test', 't', 'o/a', 'b', { force: true })).rejects.toBeTruthy();
    await expect(pullRequestsForBranch('flap.test', 't', 'o/a', 'b', { force: true })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears the mark once the host answers again', async () => {
    let first = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (first) { first = false; throw new DOMException('timed out', 'TimeoutError'); }
      return new Response('[]', { status: 200 });
    });

    await expect(pullRequestsForBranch('back.test', 't', 'o/a', 'b1', { force: true })).rejects.toBeTruthy();
    await expect(pullRequestsForBranch('back.test', 't', 'o/a', 'b2', { force: true })).resolves.toEqual([]);
    // breaker cleared by the successful response — a fresh branch reaches the network
    await expect(pullRequestsForBranch('back.test', 't', 'o/a', 'b3')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
