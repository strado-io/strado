import { describe, expect, it } from 'vitest';
import { localizeRemoteUrl } from './remoteForward';
import type { Forward } from '../api';

const forward: Forward = {
  runnerId: 'runner-dev',
  remotePort: 3000,
  localPort: 54321,
  url: 'http://127.0.0.1:54321',
  startedAt: '2026-07-30T00:00:00.000Z',
};

describe('localizeRemoteUrl', () => {
  it('rewrites a runner-reported loopback URL to the local end of the forward', () => {
    expect(localizeRemoteUrl('http://localhost:3000', forward)).toBe('http://127.0.0.1:54321/');
    expect(localizeRemoteUrl('http://127.0.0.1:3000', forward)).toBe('http://127.0.0.1:54321/');
    // Vite prints 0.0.0.0 with --host; webpack sometimes prints [::].
    expect(localizeRemoteUrl('http://0.0.0.0:3000', forward)).toBe('http://127.0.0.1:54321/');
  });

  it('keeps the path, query and hash', () => {
    expect(localizeRemoteUrl('http://localhost:3000/app/x?q=1#top', forward)).toBe(
      'http://127.0.0.1:54321/app/x?q=1#top',
    );
  });

  it('ignores the port the runner reported', () => {
    // The whole hazard: 3000 is usually taken on the desktop too, so trusting
    // the remote port would open a different app entirely.
    const out = localizeRemoteUrl('http://localhost:3000', forward)!;
    expect(out).not.toContain(':3000');
    expect(out).toContain(':54321');
  });

  it('downgrades https on the loopback hop', () => {
    // The forward is plain TCP to 127.0.0.1; the runner's own certificate, if it
    // even has one, is not for this host and would fail to verify.
    expect(localizeRemoteUrl('https://localhost:3000/x', forward)).toBe('http://127.0.0.1:54321/x');
  });

  it('leaves a real remote host alone', () => {
    // Someone set a staging URL as the preview override; it is reachable on its
    // own terms and must not be rerouted through the tunnel.
    expect(localizeRemoteUrl('https://staging.example.com/app', forward)).toBe('https://staging.example.com/app');
  });

  it('returns null with no forward rather than the original URL', () => {
    // Returning the original would point the preview at whatever is on that port
    // on THIS machine and look like it worked. A visible "not ready" is the
    // safe failure.
    expect(localizeRemoteUrl('http://localhost:3000', null)).toBeNull();
  });

  it('falls back to the forward origin for an unparseable URL', () => {
    expect(localizeRemoteUrl('not a url', forward)).toBe('http://127.0.0.1:54321');
  });
});
