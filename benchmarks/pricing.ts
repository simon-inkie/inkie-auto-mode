import type { ProviderName } from './provider-contract.js';
import type { ProviderTokenUsage } from './provider-contract.js';

/** Benchmark-only list-price snapshot, captured 2026-09-20. */
export const PRICING_SNAPSHOT = {
  asOf: '2026-09-20',
  route: 'direct generativelanguage.googleapis.com; no cache, grounding, or batch',
  currency: 'USD',
  perMillionTokens: {
    jev: { input: 0.042, output: null },
    'google/gemini-3.8-flash': { input: 0.75, output: 3.75 },
    'google/gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  },
  caveat: 'List-price estimates excluding tax and free-tier effects; cached-content and tool-use prompt classes fail closed because their dated discounted rates are not in this snapshot.',
} as const;

export interface CostEstimate {
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  totalCostUsd: number | null;
  billableInputTokens: number;
  billableOutputTokens: number;
  unavailableReason?: string;
}

export function estimateListPriceUsd(provider: ProviderName, model: string, usage: ProviderTokenUsage): CostEstimate {
  if ((usage.cachedContentTokenCount ?? 0) > 0 || (usage.toolUsePromptTokenCount ?? 0) > 0) {
    return {
      inputCostUsd: null,
      outputCostUsd: null,
      totalCostUsd: null,
      billableInputTokens: 0,
      billableOutputTokens: 0,
      unavailableReason: 'Cached-content or tool-use prompt tokens require separate dated rates not present in this snapshot',
    };
  }
  const rates = provider === 'jev' ? PRICING_SNAPSHOT.perMillionTokens.jev
    : PRICING_SNAPSHOT.perMillionTokens[model as keyof typeof PRICING_SNAPSHOT.perMillionTokens];
  if (!rates) return { inputCostUsd: null, outputCostUsd: null, totalCostUsd: null, billableInputTokens: 0, billableOutputTokens: 0 };
  const billableInputTokens = Math.max(0, usage.inputTokens - (usage.cachedContentTokenCount ?? 0));
  const billableOutputTokens = usage.outputTokens + (usage.thoughtsTokenCount ?? 0);
  const inputCostUsd = rates.input === null ? null : billableInputTokens / 1_000_000 * rates.input;
  const outputCostUsd = rates.output === null ? null : billableOutputTokens / 1_000_000 * rates.output;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd !== null && outputCostUsd !== null ? inputCostUsd + outputCostUsd : null,
    billableInputTokens,
    billableOutputTokens,
  };
}
