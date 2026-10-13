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
  // hosted examples (update deliberately)
  "gpt-4o": { inUsdPerM: 2.5, outUsdPerM: 10 },
  "gpt-4o-mini": { inUsdPerM: 0.15, outUsdPerM: 0.6 },
  "claude-sonnet-4-5": { inUsdPerM: 3, outUsdPerM: 15 },
};

/** Cost of one run in USD, or null when the model has no committed price. */
export function costUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const usd = (tokensIn * p.inUsdPerM + tokensOut * p.outUsdPerM) / 1e6;
  return Math.round(usd * 10000) / 10000;
}
