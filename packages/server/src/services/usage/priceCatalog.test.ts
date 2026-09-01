import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPriceCatalog, parseLiteLLM } from './priceCatalog.js';
import { createPricer } from './pricing.js';

let stateDir = '';

/** A slice of the real catalog, field names and all. */
const payload = {
  'claude-opus-5': {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
    cache_read_input_token_cost: 5e-7,
  },
  'gpt-5.6-sol': {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_creation_input_token_cost: 5e-6,
    cache_read_input_token_cost: 4e-7,
    input_cost_per_token_above_272k_tokens: 8e-6,
    output_cost_per_token_above_272k_tokens: 3e-5,
    cache_creation_input_token_cost_above_272k_tokens: 1e-5,
    cache_read_input_token_cost_above_272k_tokens: 8e-7,
  },
  'embedding-model': { input_cost_per_token: 1e-7 },
  'not-an-object': 'nope',
};

const padded = (rows = 60) => ({
  ...payload,
  ...Object.fromEntries(Array.from({ length: rows }, (_, index) => [
    `filler-${index}`,
    { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  ])),
});

const okFetch = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-prices-'));
});

afterEach(async () => {
  await fsp.rm(stateDir, { recursive: true, force: true });
});

describe('parseLiteLLM', () => {
  it('converts per-token rates to per-million', () => {
    const table = parseLiteLLM(payload);

    expect(table['claude-opus-5']).toMatchObject({
      input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10,
    });
  });

  it('reads the long-context threshold off the field name', () => {
    const table = parseLiteLLM(payload);

    const long = table['gpt-5.6-sol']!.long!;
    expect(long.over).toBe(272_000);
    expect(long.input).toBeCloseTo(8, 6);
    expect(long.output).toBeCloseTo(30, 6);
    // Floating point: 8e-7 * 1e6 is not exactly 0.8.
    expect(long.cacheRead).toBeCloseTo(0.8, 6);
    expect(long.cacheWrite).toBeCloseTo(10, 6);
  });

  it('skips rows without both an input and an output rate', () => {
    const table = parseLiteLLM(payload);

    expect(table['embedding-model']).toBeUndefined();
    expect(table['not-an-object']).toBeUndefined();
  });

  it('derives a missing 1-hour rate rather than dropping the model', () => {
    const table = parseLiteLLM({
      'model-x': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });

    expect(table['model-x']).toMatchObject({ input: 1, output: 2, cacheWrite1h: 2 });
  });

  it('returns nothing for a payload that is not a catalog', () => {
    expect(parseLiteLLM('nope')).toEqual({});
    expect(parseLiteLLM(null)).toEqual({});
  });
});

describe('createPriceCatalog', () => {
  it('is off by default when STRADO_PRICE_CATALOG says so', async () => {
    const fetchImpl = okFetch(padded());
    const previous = process.env.STRADO_PRICE_CATALOG;
    process.env.STRADO_PRICE_CATALOG = 'off';
    try {
      const catalog = createPriceCatalog({ stateDir, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect((await catalog.rates()).provenance.source).toBe('builtin');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.STRADO_PRICE_CATALOG;
      else process.env.STRADO_PRICE_CATALOG = previous;
    }
  });

  it('fetches, prices from the catalog, and reports provenance', async () => {
    const fetchImpl = okFetch(padded());
    const catalog = createPriceCatalog({ stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: true });

    const { table, provenance } = await catalog.rates();

    expect(provenance.source).toBe('litellm');
    expect(provenance.fetchedAt).not.toBeNull();
    expect(createPricer(table).cost('gpt-5.6-sol', {
      input: 1_000_000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0,
    }).cost).toBeCloseTo(4, 6);
  });

  it('serves a second call from memory without refetching', async () => {
    const fetchImpl = okFetch(padded());
    const catalog = createPriceCatalog({ stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: true });

    await catalog.rates();
    await catalog.rates();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between concurrent callers', async () => {
    const fetchImpl = okFetch(padded());
    const catalog = createPriceCatalog({ stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: true });

    await Promise.all([catalog.rates(), catalog.rates(), catalog.rates()]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reuses the cache a later process wrote', async () => {
    const fetchImpl = okFetch(padded());
    await createPriceCatalog({ stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: true }).rates();
    const second = okFetch(padded());

    const { provenance } = await createPriceCatalog({
      stateDir, fetchImpl: second as unknown as typeof fetch,
    }).rates();

    expect(second).not.toHaveBeenCalled();
    expect(provenance.source).toBe('litellm');
  });

  it('refetches once the cache is older than the ttl', async () => {
    const fetchImpl = okFetch(padded());
    await createPriceCatalog({ stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: true }).rates();
    const second = okFetch(padded());

    await createPriceCatalog({
      stateDir, fetchImpl: second as unknown as typeof fetch, ttlMs: -1, enabled: true,
    }).rates();

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('falls back to the built-in table when offline with no cache', async () => {
    const catalog = createPriceCatalog({
      stateDir,
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
      enabled: true,
    });

    const { table, provenance } = await catalog.rates();

    expect(provenance).toEqual({ source: 'builtin', fetchedAt: null });
    expect(createPricer(table).known('claude-opus-5')).toBe(true);
  });

  it('keeps the built-in table when the payload is truncated', async () => {
    const catalog = createPriceCatalog({
      stateDir,
      fetchImpl: okFetch({ 'claude-opus-5': payload['claude-opus-5'] }) as unknown as typeof fetch,
      enabled: true,
    });

    expect((await catalog.rates()).provenance.source).toBe('builtin');
  });

  it('keeps the built-in table on a non-200 response', async () => {
    const catalog = createPriceCatalog({
      stateDir,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      enabled: true,
    });

    expect((await catalog.rates()).provenance.source).toBe('builtin');
  });

  it('never reaches the network when switched off', async () => {
    const fetchImpl = okFetch(padded());
    const catalog = createPriceCatalog({
      stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: false,
    });

    const { provenance } = await catalog.rates();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provenance).toEqual({ source: 'builtin', fetchedAt: null });
  });

  it('still uses a cache already on disk when switched off', async () => {
    await createPriceCatalog({
      stateDir, fetchImpl: okFetch(padded()) as unknown as typeof fetch, enabled: true,
    }).rates();
    const fetchImpl = okFetch(padded());

    const { provenance } = await createPriceCatalog({
      stateDir, fetchImpl: fetchImpl as unknown as typeof fetch, enabled: false, ttlMs: -1,
    }).rates();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provenance.source).toBe('litellm');
  });

  it('still prices a model the catalog omits', async () => {
    const catalog = createPriceCatalog({
      stateDir,
      fetchImpl: okFetch(padded()) as unknown as typeof fetch,
      enabled: true,
    });

    const { table } = await catalog.rates();

    expect(createPricer(table).known('claude-fable-5')).toBe(true);
  });
});
