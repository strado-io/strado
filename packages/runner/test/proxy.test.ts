import { describe, expect, it } from 'vitest';
import { getGlobalDispatcher } from 'undici';
import { applyProxyFromEnv, proxyFromEnv } from '../src/proxy.js';

describe('runner proxy', () => {
  it('reads the usual variables, uppercase first', () => {
    expect(proxyFromEnv({})).toBeNull();
    expect(proxyFromEnv({ http_proxy: 'http://p:3128' })).toBe('http://p:3128');
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe('http://a:1');
  });
  it('installs an env-driven dispatcher for fetch when a proxy is set', () => {
    const before = getGlobalDispatcher();
    expect(applyProxyFromEnv({})).toBeNull();
    expect(getGlobalDispatcher()).toBe(before);
    expect(applyProxyFromEnv({ HTTPS_PROXY: 'http://proxy.corp:3128' })).toBe('http://proxy.corp:3128');
    expect(getGlobalDispatcher()).not.toBe(before);
    expect(getGlobalDispatcher().constructor.name).toBe('EnvHttpProxyAgent');
  });
});
