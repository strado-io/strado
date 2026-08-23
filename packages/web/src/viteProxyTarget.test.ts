import { describe, it, expect } from 'vitest';

/**
 * @vitest-environment node
 *
 * Importing vite.config pulls in vite and esbuild. esbuild's invariant check
 * `new TextEncoder().encode("") instanceof Uint8Array` fails under jsdom because
 * jsdom provides its own TextEncoder that is not a Node.js Uint8Array constructor.
 * The node environment is required to load the config file.
 */
import { proxyTarget } from '../vite.config.js';

describe('proxyTarget', () => {
  it('defaults to the stable instance so bare vite is unchanged', () => {
    expect(proxyTarget({})).toEqual({
      http: 'http://127.0.0.1:7777',
      ws: 'ws://127.0.0.1:7777',
    });
  });

  it('follows STRADO_SERVER_PORT when the dev profile sets it', () => {
    expect(proxyTarget({ STRADO_SERVER_PORT: '7877' })).toEqual({
      http: 'http://127.0.0.1:7877',
      ws: 'ws://127.0.0.1:7877',
    });
  });

  it('ignores an empty value rather than resolving to port 0', () => {
    expect(proxyTarget({ STRADO_SERVER_PORT: '' })).toEqual({
      http: 'http://127.0.0.1:7777',
      ws: 'ws://127.0.0.1:7777',
    });
  });

  it('ignores a non-numeric value', () => {
    expect(proxyTarget({ STRADO_SERVER_PORT: 'abc' })).toEqual({
      http: 'http://127.0.0.1:7777',
      ws: 'ws://127.0.0.1:7777',
    });
  });

  it('rejects port 0 and falls back to 7777', () => {
    expect(proxyTarget({ STRADO_SERVER_PORT: '0' })).toEqual({
      http: 'http://127.0.0.1:7777',
      ws: 'ws://127.0.0.1:7777',
    });
  });

  it('rejects negative ports and falls back to 7777', () => {
    expect(proxyTarget({ STRADO_SERVER_PORT: '-1' })).toEqual({
      http: 'http://127.0.0.1:7777',
      ws: 'ws://127.0.0.1:7777',
    });
  });

  it('rejects non-integer ports and falls back to 7777', () => {
    expect(proxyTarget({ STRADO_SERVER_PORT: '7877.5' })).toEqual({
      http: 'http://127.0.0.1:7777',
      ws: 'ws://127.0.0.1:7777',
    });
  });
});
