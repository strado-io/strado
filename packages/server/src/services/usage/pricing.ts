/**
 * Per-model API list prices, used to turn local session-log token counts into a
 * "what this would cost at full API rate" figure. Subscription plans do not
 * bill per token, so every number derived from here is an estimate the UI
 * labels as such.
 *
 * Rates are $ per million tokens. Cache write is 1.25x input and cache read is
 * 0.1x input across the Anthropic range, so both are derived rather than
 * duplicated per row.
 */
export type TokenCounts = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

type Rate = { input: number; output: number };

const PER_MILLION: Record<string, Rate> = {
  // Anthropic — first-party API rates.
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI — the GPT-5 family rates Codex bills against.
  'gpt-5.6': { input: 1.25, output: 10 },
  'gpt-5.6-codex': { input: 1.25, output: 10 },
  'gpt-5.5': { input: 1.25, output: 10 },
  'gpt-5.5-codex': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-codex': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

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
  return id;
}

function rateFor(model: string): Rate | null {
  return PER_MILLION[normalizeModelId(model)] ?? null;
}

/** Priced with the cache discounts the agent actually got. */
export function priceUsd(model: string, tokens: TokenCounts): { cost: number; known: boolean } {
  const rate = rateFor(model);
  if (!rate) return { cost: 0, known: false };
  const perInput = rate.input / 1_000_000;
  const cost =
    tokens.input * perInput
    + tokens.cacheWrite * perInput * CACHE_WRITE_MULTIPLIER
    + tokens.cacheRead * perInput * CACHE_READ_MULTIPLIER
    + tokens.output * (rate.output / 1_000_000);
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
  const asInput = tokens.input + tokens.cacheWrite + tokens.cacheRead;
  return asInput * (rate.input / 1_000_000) + tokens.output * (rate.output / 1_000_000);
}

/** True when the price table has a row for this model. */
export function isKnownModel(model: string): boolean {
  return rateFor(model) !== null;
}
