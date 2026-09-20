import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { estimateListPriceUsd, PRICING_SNAPSHOT } from '../benchmarks/pricing.js';

test('Gemini pricing fails closed when discounted token classes are present', () => {
  const estimate = estimateListPriceUsd('gemini', 'google/gemini-3.8-flash', {
    inputTokens: 100, outputTokens: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 30,
    toolUsePromptTokenCount: 2, totalTokenCount: 125,
  });
  assert.equal(estimate.billableInputTokens, 0);
  assert.equal(estimate.billableOutputTokens, 0);
  assert.equal(estimate.inputCostUsd, null);
  assert.match(estimate.unavailableReason ?? '', /separate dated rates/);
});

test('Gemini list price bills candidate and thought output when no discounted classes are present', () => {
  const estimate = estimateListPriceUsd('gemini', 'google/gemini-3.8-flash', {
    inputTokens: 100, outputTokens: 20, thoughtsTokenCount: 5,
  });
  assert.equal(estimate.billableInputTokens, 100);
  assert.equal(estimate.billableOutputTokens, 25);
  assert.ok(Math.abs((estimate.totalCostUsd ?? 0) - 0.00016875) < 1e-12);
});

test('Jev preserves token totals but reports an explicitly unpriced output leg', () => {
  const estimate = estimateListPriceUsd('jev', 'jev-1.13.0', {
    inputTokens: 42, outputTokens: 7, totalTokenCount: 49,
  });
  assert.equal(estimate.billableInputTokens, 42);
  assert.equal(estimate.inputCostUsd, 0.000001764);
  assert.equal(estimate.outputCostUsd, null);
  assert.equal(estimate.totalCostUsd, null);
});

test('pricing snapshot records direct route and date', () => {
  assert.equal(PRICING_SNAPSHOT.asOf, '2026-09-20');
  assert.match(PRICING_SNAPSHOT.route, /generativelanguage\.googleapis\.com/);
  assert.match(PRICING_SNAPSHOT.route, /no cache, grounding, or batch/);
});
