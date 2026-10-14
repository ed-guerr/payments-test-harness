/**
 * eval/pricing.ts — committed price table for cost accounting (roadmap R6).
 *
 * USD per 1M tokens, keyed by the model id used in EVAL_API_MODEL. Missing
 * entry → costUsd returns null (never a guess). Local models are listed as
 * $0.00 — the token columns in the report are still what a local run "costs"
 * in compute time. Hosted entries are a convenience, not a price promise:
 * update deliberately when you point the eval at a new model.
 */

const PRICING: Record<string, { inUsdPerM: number; outUsdPerM: number }> = {
  // local models (llama.cpp / LM Studio / …) — no API cost
  qwen3: { inUsdPerM: 0, outUsdPerM: 0 },
  local: { inUsdPerM: 0, outUsdPerM: 0 },
  "google/gemma-4-12b-qat": { inUsdPerM: 0, outUsdPerM: 0 },
  // hosted examples (update deliberately)
  // gpt-6-luna: base tier (per-M at 272k context); the >272k tier (0.2/0.75)
  // never applies — a single eval run is far below one context window.
  "gpt-6-luna": { inUsdPerM: 0.1, outUsdPerM: 0.5 },
  "gpt-4o": { inUsdPerM: 2.5, outUsdPerM: 10 },
  "gpt-4o-mini": { inUsdPerM: 0.15, outUsdPerM: 0.6 },
  "claude-sonnet-4-5": { inUsdPerM: 3, outUsdPerM: 15 },
};

/** Cost of one run in USD, or null when the model has no committed price.
 *  A model id that is a GGUF file path (single-model llama.cpp servers list
 *  the file, not an alias) is by definition local: $0.00, not a guess. */
export function costUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  const p = PRICING[model] ?? (model.endsWith(".gguf") ? { inUsdPerM: 0, outUsdPerM: 0 } : undefined);
  if (!p) return null;
  const usd = (tokensIn * p.inUsdPerM + tokensOut * p.outUsdPerM) / 1e6;
  return Math.round(usd * 10000) / 10000;
}
