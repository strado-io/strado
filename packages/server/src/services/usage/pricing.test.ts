import { describe, expect, it } from 'vitest';
import { fullRateUsd, normalizeModelId, priceUsd, type TokenCounts } from './pricing.js';

const tokens = (over: Partial<TokenCounts> = {}): TokenCounts =>
  ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...over });

describe('normalizeModelId', () => {
  it('drops a trailing date stamp', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('strips bedrock and vertex prefixes', () => {
    expect(normalizeModelId('us.anthropic.claude-opus-5-v1:0')).toBe('claude-opus-5');
  });

  it('keeps a known id untouched', () => {
    expect(normalizeModelId('claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeModelId('gpt-5.6-codex')).toBe('gpt-5.6-codex');
  });

  it('lowercases and trims', () => {
    expect(normalizeModelId('  Claude-Opus-5  ')).toBe('claude-opus-5');
  });
});

describe('priceUsd', () => {
  it('prices a million input tokens at the table rate', () => {
    const { cost, known } = priceUsd('claude-opus-5', tokens({ input: 1_000_000 }));
    expect(known).toBe(true);
    expect(cost).toBeCloseTo(5, 6);
  });

  it('prices output higher than input', () => {
    const input = priceUsd('claude-opus-5', tokens({ input: 1_000_000 })).cost;
    const output = priceUsd('claude-opus-5', tokens({ output: 1_000_000 })).cost;
    expect(output).toBeGreaterThan(input);
  });

  it('prices cache reads at a tenth of input', () => {
    const read = priceUsd('claude-opus-5', tokens({ cacheRead: 1_000_000 })).cost;
    const input = priceUsd('claude-opus-5', tokens({ input: 1_000_000 })).cost;
    expect(read).toBeCloseTo(input / 10, 6);
  });

  it('prices cache writes above input', () => {
    const write = priceUsd('claude-opus-5', tokens({ cacheWrite: 1_000_000 })).cost;
    const input = priceUsd('claude-opus-5', tokens({ input: 1_000_000 })).cost;
    expect(write).toBeGreaterThan(input);
  });

  it('sums every token class', () => {
    const t = tokens({ input: 1_000, cacheWrite: 2_000, cacheRead: 500_000, output: 10_000 });
    const parts =
      priceUsd('claude-sonnet-5', tokens({ input: 1_000 })).cost
      + priceUsd('claude-sonnet-5', tokens({ cacheWrite: 2_000 })).cost
      + priceUsd('claude-sonnet-5', tokens({ cacheRead: 500_000 })).cost
      + priceUsd('claude-sonnet-5', tokens({ output: 10_000 })).cost;
    expect(priceUsd('claude-sonnet-5', t).cost).toBeCloseTo(parts, 10);
  });

  it('falls back to the family rate for an unlisted variant', () => {
    expect(priceUsd('gpt-5.6-terra', tokens({ input: 1_000_000 })))
      .toEqual(priceUsd('gpt-5.6', tokens({ input: 1_000_000 })));
    expect(priceUsd('claude-opus-5-preview', tokens({ output: 1_000_000 })))
      .toEqual(priceUsd('claude-opus-5', tokens({ output: 1_000_000 })));
  });

  it('never guesses a price for an unknown model', () => {
    expect(priceUsd('llama-4-maverick', tokens({ input: 1_000_000 }))).toEqual({ cost: 0, known: false });
  });

  it('prices codex models', () => {
    expect(priceUsd('gpt-5.6', tokens({ input: 1_000_000 })).known).toBe(true);
    expect(priceUsd('gpt-5.6-sol', tokens({ input: 1_000_000 })).known).toBe(true);
  });
});

describe('fullRateUsd', () => {
  it('charges cache reads and writes as plain input', () => {
    const t = tokens({ input: 100, cacheWrite: 1_000, cacheRead: 1_000_000 });
    const plain = priceUsd('claude-opus-5', tokens({ input: 1_001_100 })).cost;
    expect(fullRateUsd('claude-opus-5', t)).toBeCloseTo(plain, 6);
  });

  it('is zero for an unknown model', () => {
    expect(fullRateUsd('llama-4-maverick', tokens({ cacheRead: 1_000_000 }))).toBe(0);
  });
});
