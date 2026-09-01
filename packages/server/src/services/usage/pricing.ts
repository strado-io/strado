/**
 * Model rates, used to turn local session-log token counts into a "what this
 * would cost at full API rate" figure. Subscription plans do not bill per
 * token, so every number derived from here is an estimate the UI labels as
 * such.
 *
 * Rates are $ per million tokens. The built-in table is the offline fallback;
 * `priceCatalog.ts` fetches current rates and overrides it. Cross-checked
 * against ccusage (Claude) and CodexBar (Codex) on the same logs.
 */
export type TokenCounts = {
  input: number;
  /** 5-minute cache writes. */
  cacheWrite: number;
  /** 1-hour cache writes, billed above the 5-minute rate. */
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

/** Every rate class we price, in $ per million tokens. */
export type Rate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  /**
   * Rates for a prompt past `over` tokens: vendors bill the whole request at
   * the higher band. Absent on models with a single band.
   */
  long?: { over: number } & Omit<Rate, 'long'>;
};

export type RateTable = Record<string, Rate>;

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;
const LONG_INPUT = 2;
const LONG_OUTPUT = 1.5;

/** Both vendors derive their cache rates from input, so one helper covers all. */
function band(input: number, output: number): Omit<Rate, 'long'> {
  return {
    input,
    output,
    cacheRead: input * CACHE_READ,
    cacheWrite: input * CACHE_WRITE_5M,
    cacheWrite1h: input * CACHE_WRITE_1H,
  };
}

function rate(input: number, output: number, longContextOver?: number): Rate {
  const base = band(input, output);
  if (longContextOver === undefined) return base;
  return {
    ...base,
    long: { over: longContextOver, ...band(input * LONG_INPUT, output * LONG_OUTPUT) },
  };
}

export const BUILTIN_RATES: RateTable = {
  // Anthropic — first-party API rates. Current models bill one band across
  // their whole context; the 200K band belongs to the older 1M-context models.
  'claude-fable-5': rate(10, 50),
  'claude-mythos-5': rate(10, 50),
  'claude-opus-5': rate(5, 25),
  'claude-opus-4-8': rate(5, 25),
  'claude-opus-4-7': rate(5, 25),
  'claude-opus-4-6': rate(5, 25),
  'claude-opus-4-5': rate(5, 25),
  'claude-sonnet-5': rate(2, 10),
  'claude-sonnet-4-6': rate(3, 15),
  'claude-sonnet-4-5': rate(3, 15, 200_000),
  'claude-haiku-4-5': rate(1, 5),
  // OpenAI — the rates Codex bills against, with the 272K long-context band.
  'gpt-5.6-sol': rate(4, 20, 272_000),
  // The family row is what an unlisted 5.6 variant falls back to.
  'gpt-5.6': rate(4, 20, 272_000),
  'gpt-5.6-terra': rate(2, 12, 272_000),
  'gpt-5.6-luna': rate(0.2, 1.2, 272_000),
  'gpt-5.5': rate(5, 30, 272_000),
  'gpt-5.5-pro': rate(30, 180),
  'gpt-5.4': rate(1.75, 14),
  'gpt-5.4-mini': rate(0.35, 2.8),
  'gpt-5.3-codex': rate(1.25, 10),
  'gpt-5.2': rate(1.25, 10),
  'gpt-5.1': rate(1.25, 10),
  'gpt-5': rate(1.25, 10),
  'gpt-5-mini': rate(0.25, 2),
  'gpt-5-nano': rate(0.05, 0.4),
};

/**
 * Log lines carry provider-decorated ids: Bedrock/Vertex prefixes, `:0` version
 * suffixes, and date stamps that change without the price changing. Strip all
 * three so one table row covers every spelling of a model.
 */
export function normalizeModelId(raw: string): string {
  let id = raw.trim().toLowerCase();
  id = id.replace(/^[a-z]{2,}\.(anthropic|openai)\./, '');
  id = id.replace(/^(anthropic|openai)\./, '');
  id = id.replace(/[@:]-?[\w.]+$/, '');
  id = id.replace(/-v\d+$/, '');
  // A trailing 8-digit date stamp (claude-haiku-4-5-20251001).
  id = id.replace(/-\d{8}$/, '');
  // Codex writes the family name for its default variant.
  if (id === 'gpt-5.6') return 'gpt-5.6-sol';
  return id;
}

/**
 * Vendors ship named variants faster than any catalog tracks them
 * (`gpt-5.6-nova`, `claude-opus-5-preview`). Falling back to the family the
 * variant was cut from prices it at its base rate instead of reporting the turn
 * as free.
 */
export function rateFor(model: string, table: RateTable): Rate | null {
  let id = normalizeModelId(model);
  for (;;) {
    const found = table[id];
    if (found) return found;
    const cut = id.lastIndexOf('-');
    if (cut <= 0) return null;
    id = id.slice(0, cut);
  }
}

export const promptSize = (tokens: TokenCounts): number =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.cacheWrite1h;

/**
 * Which price band a request fell in. Decided when the log line is parsed —
 * it is a property of the request, not of today's rates — so cached history
 * reprices correctly when the catalog updates.
 */
export function bandFor(model: string, tokens: TokenCounts, table: RateTable): 'std' | 'long' {
  const found = rateFor(model, table);
  if (!found?.long) return 'std';
  return promptSize(tokens) > found.long.over ? 'long' : 'std';
}

function bandRates(found: Rate, which: 'std' | 'long'): Omit<Rate, 'long'> {
  if (which === 'long' && found.long) {
    const { over, ...rest } = found.long;
    void over;
    return rest;
  }
  return found;
}

export type Pricer = {
  /** Priced with the cache discounts and context band the turn actually got. */
  cost(model: string, tokens: TokenCounts, which?: 'std' | 'long'): { cost: number; known: boolean };
  /**
   * What the same tokens would have cost with no cache at all — cached and
   * written tokens billed as plain input. The gap against `cost` is the cache
   * saving the Usage page reports.
   */
  fullRate(model: string, tokens: TokenCounts, which?: 'std' | 'long'): number;
  known(model: string): boolean;
  band(model: string, tokens: TokenCounts): 'std' | 'long';
};

/** A pricer bound to one rate table. */
export function createPricer(table: RateTable = BUILTIN_RATES): Pricer {
  return {
    cost(model, tokens, which = 'std') {
      const found = rateFor(model, table);
      if (!found) return { cost: 0, known: false };
      const r = bandRates(found, which);
      const cost =
        (tokens.input * r.input
          + tokens.cacheWrite * r.cacheWrite
          + tokens.cacheWrite1h * r.cacheWrite1h
          + tokens.cacheRead * r.cacheRead
          + tokens.output * r.output) / 1_000_000;
      return { cost, known: true };
    },
    fullRate(model, tokens, which = 'std') {
      const found = rateFor(model, table);
      if (!found) return 0;
      const r = bandRates(found, which);
      return (promptSize(tokens) * r.input + tokens.output * r.output) / 1_000_000;
    },
    known(model) {
      return rateFor(model, table) !== null;
    },
    band(model, tokens) {
      return bandFor(model, tokens, table);
    },
  };
}

const builtin = createPricer();

/** Convenience wrappers over the built-in table, for callers without a catalog. */
export const priceUsd = (model: string, tokens: TokenCounts, which?: 'std' | 'long') =>
  builtin.cost(model, tokens, which);
export const fullRateUsd = (model: string, tokens: TokenCounts, which?: 'std' | 'long') =>
  builtin.fullRate(model, tokens, which);
export const isKnownModel = (model: string) => builtin.known(model);
