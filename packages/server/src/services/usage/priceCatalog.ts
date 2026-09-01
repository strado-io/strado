import fsp from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './claudeLogs.js';
import { BUILTIN_RATES, type Rate, type RateTable } from './pricing.js';

/** Where the rates in force came from, shown next to the cost figures. */
export type PriceProvenance = {
  source: 'litellm' | 'builtin';
  /** When the catalog was fetched; null for the built-in table. */
  fetchedAt: string | null;
};

export type PriceCatalog = {
  /** Current rates, refreshing at most once per TTL. Never throws. */
  rates(): Promise<{ table: RateTable; provenance: PriceProvenance }>;
};

/**
 * The catalog ccusage prices against. Chosen over models.dev because it is the
 * only public catalog that publishes the 1-hour cache-write rate, which is the
 * largest single driver in Claude Code spend.
 */
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** A catalog this small is a truncated download, not a price list. */
const MIN_ROWS = 50;

type Cached = { fetchedAt: string; rates: RateTable };

const perMillion = (perToken: unknown): number | null =>
  (typeof perToken === 'number' && Number.isFinite(perToken) && perToken >= 0 ? perToken * 1_000_000 : null);

/**
 * LiteLLM publishes one flat object per model with `*_per_token` rates plus
 * suffixed variants for the 1-hour cache and the long-context band. Only the
 * fields we price are read; a row without an input and output rate is skipped
 * rather than half-parsed.
 */
export function parseLiteLLM(payload: unknown): RateTable {
  if (!isRecord(payload)) return {};
  const table: RateTable = {};
  for (const [model, entry] of Object.entries(payload)) {
    if (!isRecord(entry)) continue;
    const input = perMillion(entry.input_cost_per_token);
    const output = perMillion(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    const band = (suffix: string): Omit<Rate, 'long'> | null => {
      const at = (key: string) => perMillion(entry[`${key}${suffix}`]);
      const bandInput = at('input_cost_per_token');
      const bandOutput = at('output_cost_per_token');
      if (bandInput === null || bandOutput === null) return null;
      const read = at('cache_read_input_token_cost');
      const write = at('cache_creation_input_token_cost');
      return {
        input: bandInput,
        output: bandOutput,
        // Vendors that publish no cache rate bill cache traffic as plain input.
        cacheRead: read ?? bandInput,
        cacheWrite: write ?? bandInput,
        cacheWrite1h: perMillion(entry[`cache_creation_input_token_cost_above_1hr${suffix}`])
          ?? (write !== null ? write * 1.6 : bandInput * 2),
      };
    };

    const standard = band('');
    if (!standard) continue;
    // The long-context suffix names the threshold, so the threshold is read
    // off the key rather than assumed.
    const longKey = Object.keys(entry).find((key) => /^input_cost_per_token_above_\d+k_tokens$/.test(key));
    const over = longKey ? Number(/above_(\d+)k_tokens$/.exec(longKey)?.[1]) * 1000 : null;
    const longBand = longKey ? band(longKey.replace('input_cost_per_token', '')) : null;

    table[model] = over && longBand ? { ...standard, long: { over, ...longBand } } : standard;
  }
  return table;
}

export type PriceCatalogOptions = {
  /** Where the fetched catalog is cached; `app.deps.homeStateDir`. */
  stateDir: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  /**
   * Off means never reach the network: a cache already on disk is still used,
   * otherwise the built-in table prices everything. Set
   * `STRADO_PRICE_CATALOG=off` to keep the app fully local.
   */
  enabled?: boolean;
};

/**
 * Model rates, fetched once a day and cached on disk.
 *
 * Every failure path — offline, a 500, a truncated or reshaped payload — falls
 * back to the last good cache and then to the built-in table, so a network
 * problem changes the provenance line on the page, never the page itself.
 */
export function createPriceCatalog({
  stateDir,
  fetchImpl = fetch,
  ttlMs = DEFAULT_TTL_MS,
  enabled = process.env.STRADO_PRICE_CATALOG !== 'off',
}: PriceCatalogOptions): PriceCatalog {
  const cacheFile = path.join(stateDir, 'usage-prices.json');
  let memo: Cached | null = null;
  let inFlight: Promise<void> | null = null;

  async function readCache(): Promise<Cached | null> {
    if (memo) return memo;
    try {
      const parsed = JSON.parse(await fsp.readFile(cacheFile, 'utf8')) as Cached;
      if (!isRecord(parsed.rates) || Object.keys(parsed.rates).length < MIN_ROWS) return null;
      memo = parsed;
      return memo;
    } catch {
      return null;
    }
  }

  async function refresh(): Promise<void> {
    try {
      const res = await fetchImpl(LITELLM_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const rates = parseLiteLLM(await res.json());
      if (Object.keys(rates).length < MIN_ROWS) return;
      memo = { fetchedAt: new Date().toISOString(), rates };
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(memo), 'utf8');
    } catch {
      // Keep whatever we had; the provenance line will show its age.
    }
  }

  return {
    async rates() {
      const cached = await readCache();
      const stale = !cached || Date.now() - Date.parse(cached.fetchedAt) > ttlMs;
      if (stale && enabled) {
        // One refresh at a time, and callers share it: a cold start should not
        // fire a download per request.
        inFlight ??= refresh().finally(() => { inFlight = null; });
        await inFlight;
      }
      const current = memo ?? cached;
      if (!current) return { table: BUILTIN_RATES, provenance: { source: 'builtin', fetchedAt: null } };
      // The fetched catalog covers what the vendors publish; the built-in table
      // stays underneath it so a model the catalog omits is still priced.
      return {
        table: { ...BUILTIN_RATES, ...current.rates },
        provenance: { source: 'litellm', fetchedAt: current.fetchedAt },
      };
    },
  };
}
