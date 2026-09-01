/**
 * Per-model API list prices, used to turn local session-log token counts into a
 * "what this would cost at full API rate" figure. Subscription plans do not
 * bill per token, so every number derived from here is an estimate the UI
 * labels as such.
 *
 * Rates are $ per million tokens. Cross-checked against ccusage (Claude) and
 * CodexBar (Codex) on the same logs.
 */
export type TokenCounts = {
  input: number;
  /** 5-minute cache writes, billed at 1.25x input. */
  cacheWrite: number;
  /** 1-hour cache writes, billed at 2x input. */
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

type Rate = {
  input: number;
  output: number;
  /**
   * Prompts larger than this are billed at long-context rates for the whole
   * request: input, cache read and cache write double, output is 1.5x. Absent
   * on models with a single price band.
   */
  longContextOver?: number;
};

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;
const LONG_INPUT_MULTIPLIER = 2;
const LONG_OUTPUT_MULTIPLIER = 1.5;

const PER_MILLION: Record<string, Rate> = {
  // Anthropic — first-party API rates. Current models bill one band across
  // their whole context; the 200K band belongs to the older 1M-context models.
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15, longContextOver: 200_000 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI — the rates Codex bills against, with the 272K long-context band.
  'gpt-5.6-sol': { input: 5, output: 30, longContextOver: 272_000 },
  // The family row is what an unlisted 5.6 variant falls back to.
  'gpt-5.6': { input: 5, output: 30, longContextOver: 272_000 },
  'gpt-5.6-terra': { input: 2, output: 12, longContextOver: 272_000 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, longContextOver: 272_000 },
  'gpt-5.5': { input: 5, output: 30, longContextOver: 272_000 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.4': { input: 1.75, output: 14 },
  'gpt-5.4-mini': { input: 0.35, output: 2.8 },
  'gpt-5.3-codex': { input: 1.25, output: 10 },
  'gpt-5.2': { input: 1.25, output: 10 },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
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
 * Vendors ship named variants of a model faster than a price table can track
 * them (`gpt-5.6-nova`, `claude-opus-5-preview`). Falling back to the family
 * the variant was cut from prices it at its base rate instead of reporting the
 * turn as free.
 */
function rateFor(model: string): Rate | null {
  let id = normalizeModelId(model);
  for (;;) {
    const rate = PER_MILLION[id];
    if (rate) return rate;
    const cut = id.lastIndexOf('-');
    if (cut <= 0) return null;
    id = id.slice(0, cut);
  }
}

const promptSize = (tokens: TokenCounts): number =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.cacheWrite1h;

/** Priced with the cache discounts and context band the turn actually got. */
export function priceUsd(model: string, tokens: TokenCounts): { cost: number; known: boolean } {
  const rate = rateFor(model);
  if (!rate) return { cost: 0, known: false };
  const long = rate.longContextOver !== undefined && promptSize(tokens) > rate.longContextOver;
  const perInput = (rate.input / 1_000_000) * (long ? LONG_INPUT_MULTIPLIER : 1);
  const perOutput = (rate.output / 1_000_000) * (long ? LONG_OUTPUT_MULTIPLIER : 1);
  const cost =
    tokens.input * perInput
    + tokens.cacheWrite * perInput * CACHE_WRITE_5M
    + tokens.cacheWrite1h * perInput * CACHE_WRITE_1H
    + tokens.cacheRead * perInput * CACHE_READ
    + tokens.output * perOutput;
  return { cost, known: true };
}

/**
 * What the same tokens would have cost with no cache at all — cached and
 * written tokens billed as plain input. The gap against `priceUsd` is the
 * cache saving the Usage page reports.
 */
export function fullRateUsd(model: string, tokens: TokenCounts): number {
  const rate = rateFor(model);
  if (!rate) return 0;
  const long = rate.longContextOver !== undefined && promptSize(tokens) > rate.longContextOver;
  const perInput = (rate.input / 1_000_000) * (long ? LONG_INPUT_MULTIPLIER : 1);
  const perOutput = (rate.output / 1_000_000) * (long ? LONG_OUTPUT_MULTIPLIER : 1);
  return promptSize(tokens) * perInput + tokens.output * perOutput;
}

/** True when the price table has a row for this model. */
export function isKnownModel(model: string): boolean {
  return rateFor(model) !== null;
}
