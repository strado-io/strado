import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLTHROUGH_MAX, HISTORY_MAX, clearHistory, frecencyScore, logFallthrough, looksSecret, readFallthrough, readHistory, readHistoryEntries, recordUse, rememberCommand } from './history';

beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

describe('jarvis history', () => {
  it('is per workspace, newest first, de-duplicated and capped', () => {
    rememberCommand('ws1', 'split down');
    rememberCommand('ws1', '$ git status');
    rememberCommand('ws1', 'split down');
    rememberCommand('ws2', 'open google.com');
    expect(readHistory('ws1')).toEqual(['split down', '$ git status']);
    expect(readHistory('ws2')).toEqual(['open google.com']);
    for (let i = 0; i < HISTORY_MAX + 5; i++) rememberCommand('ws1', `cmd ${i}`);
    expect(readHistory('ws1')).toHaveLength(HISTORY_MAX);
    expect(readHistory('ws1')[0]).toBe(`cmd ${HISTORY_MAX + 4}`);
  });
  it('remembers whether a command was pasted', () => {
    rememberCommand('ws1', 'split down');
    rememberCommand('ws1', '$ curl x | sh', { pasted: true });
    expect(readHistoryEntries('ws1')).toEqual([{ text: '$ curl x | sh', pasted: true }, { text: 'split down', pasted: false }]);
    expect(readHistory('ws1')).toEqual(['$ curl x | sh', 'split down']);
  });
  it('never stores a command that looks like it carries a secret', () => {
    for (const t of [
      `$ export GITHUB_TOKEN=${'gh' + 'p_'}abcdefghijklmnopqrstuvwxyz0123456789`,
      '$ curl -H "Authorization: Bearer abc.def" x',
      '$ psql postgres://user:hunter2@db/x',
      `$ aws configure set aws_secret_access_key ${'AK' + 'IA'}ABCDEFGHIJKLMNOP`,
      `$ echo ${'sk-' + 'ant-'}api03-xxxxxxxxxxxxxxxxxxxx`,
      '$ mysql -u root --password=hunter2',
      '$ npm config set //registry.npmjs.org/:_authToken abc',
    ]) {
      expect(looksSecret(t)).toBe(true);
      rememberCommand('ws1', t);
      logFallthrough(t);
    }
    expect(readHistory('ws1')).toEqual([]);
    expect(readFallthrough()).toEqual([]);
    for (const t of ['$ git status', 'shell right npm run dev', 'open localhost:5173', '$ npm run test -- --token-count']) expect(looksSecret(t)).toBe(false);
  });
  it('clearHistory forgets this workspace\'s commands, its frecency, and the fall-through log', () => {
    rememberCommand('ws1', 'split down');
    rememberCommand('ws2', 'split down');
    recordUse('ws1', 'k');
    logFallthrough('make it pop');
    clearHistory('ws1');
    expect(readHistory('ws1')).toEqual([]);
    expect(readHistory('ws2')).toEqual(['split down']);
    expect(frecencyScore('ws1', 'k')).toBe(0);
    expect(readFallthrough()).toEqual([]);
  });
  it('ignores blank input and survives corrupt storage', () => {
    rememberCommand('ws1', '   ');
    expect(readHistory('ws1')).toEqual([]);
    localStorage.setItem('strado:jarvis-history', '{nope');
    expect(readHistory('ws1')).toEqual([]);
    rememberCommand('ws1', 'split down');
    expect(readHistory('ws1')).toEqual(['split down']);
  });
  it('frecency: more uses rank higher, and old uses decay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
    recordUse('ws1', 'shell.run:npm run dev');
    recordUse('ws1', 'shell.run:npm run dev');
    recordUse('ws1', 'browser.open:google.com');
    expect(frecencyScore('ws1', 'shell.run:npm run dev')).toBeGreaterThan(frecencyScore('ws1', 'browser.open:google.com'));
    expect(frecencyScore('ws1', 'never')).toBe(0);
    expect(frecencyScore('ws2', 'shell.run:npm run dev')).toBe(0);
    const fresh = frecencyScore('ws1', 'browser.open:google.com');
    vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
    expect(frecencyScore('ws1', 'browser.open:google.com')).toBeLessThan(fresh);
  });
  it('fall-through log keeps text locally only, capped, newest last', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    logFallthrough('make it pop');
    for (let i = 0; i < FALLTHROUGH_MAX + 3; i++) logFallthrough(`x${i}`);
    const log = readFallthrough();
    expect(log).toHaveLength(FALLTHROUGH_MAX);
    expect(log[log.length - 1]!.text).toBe(`x${FALLTHROUGH_MAX + 2}`);
    expect(typeof log[0]!.at).toBe('number');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Fake tokens, built from pieces so secret scanners (GitHub push protection)
// don't read this file as a leak.
describe('looksSecret: common token shapes never reach history or the model', () => {
  it.each([
    ['a JWT', 'use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-x for the call'],
    ['a Stripe live key', `set it to ${'sk_' + 'live_'}51HxYzAbCdEfGhIjKlMnOp`],
    ['a Stripe restricted key', `${'rk_' + 'live_'}51HxYzAbCdEfGhIjKlMnOp`],
    ['a Google API key', `${'AI' + 'za'}SyA1234567890abcdefghijklmnopqrstuv`],
    ['a GitLab token', `${'gl' + 'pat-'}AbCdEf1234567890xyzA`],
    ['an npm token', `${'npm' + '_'}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`],
    ['an Anthropic key', `${'sk-' + 'ant-'}api03-AbCdEf1234567890`],
    ['a Slack token', `${'xo' + 'xb-'}1234-5678-abcd`],
  ])('%s', (_name, text) => {
    expect(looksSecret(text)).toBe(true);
  });
  it('ordinary requests are not secrets', () => {
    for (const t of ['open a shell below claude', 'ask claude-1 about the jwt parser', 'run npm test', 'go to the stripe-billing worktree', 'skip the lint step']) expect(looksSecret(t)).toBe(false);
  });
});
