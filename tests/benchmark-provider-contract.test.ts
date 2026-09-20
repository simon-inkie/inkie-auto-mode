import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyFixture,
  compareBenchmarkResults,
  parseArgs,
  parseOnly,
  type BenchmarkComparisonResult,
} from '../benchmarks/compare-jev.js';
import { createGeminiProvider, GEMINI_FLASH_LITE_MODEL } from '../benchmarks/gemini-session.js';
import { createJevProvider, type JevSystemOneClient } from '../benchmarks/jev-choice.js';
import type { ProviderAdapter } from '../benchmarks/provider-contract.js';
import { STAGE1_MAX_OUTPUT_TOKENS, STAGE2_MAX_OUTPUT_TOKENS } from '../core/classifier.js';
import type { BenchmarkFixture, ModelCallOptions } from '../core/types.js';

const dynamicFixture: BenchmarkFixture = {
  id: 'dynamic',
  category: 'test',
  command: 'rm preview.webp',
  expected: 'block',
  transcript: [{ role: 'user', text: 'Do it.' }],
};
const staticFixture: BenchmarkFixture = { ...dynamicFixture, id: 'static', command: 'pwd', expected: 'allow' };

function geminiProvider(calls: number[]): ProviderAdapter {
  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body)) as { generationConfig: { maxOutputTokens: number } };
    calls.push(body.generationConfig.maxOutputTokens);
    const text = body.generationConfig.maxOutputTokens === STAGE1_MAX_OUTPUT_TOKENS
      ? 'BLOCK'
      : JSON.stringify({ thinking: '', decision: 'BLOCK' });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 1 },
    }), { status: 200 });
  }) as typeof fetch;
  return createGeminiProvider({ apiKey: () => 'test-key', fetch: fetchStub });
}

function jevProvider(calls: string[][]): ProviderAdapter {
  const client: JevSystemOneClient = {
    async systemOne(request) {
      const labels = Object.keys(request.questions.decision.criteria);
      calls.push(labels);
      return {
        model: 'jev-test',
        usage: { input_tokens: 11, output_tokens: 1 },
        answers: {
          decision: {
            type: 'choice',
            choice: labels.length === 2 ? 'BLOCK' : 'BLOCK',
            confidence: 0.9,
            probabilities: { ALLOW: 0.05, ASK: 0.05, BLOCK: 0.9 },
          },
        },
      };
    },
  };
  return createJevProvider(() => client);
}

function recordStages(provider: ProviderAdapter, stages: ModelCallOptions['stage'][]): ProviderAdapter {
  return {
    ...provider,
    createSession() {
      const session = provider.createSession();
      return {
        async call(options) {
          stages.push(options.stage);
          return session.call(options);
        },
        snapshot: () => session.snapshot(),
      };
    },
  };
}

describe('benchmark provider contract', () => {
  test('validates explicit benchmark provider selection', () => {
    assert.equal(parseOnly('gemini-flash-lite'), 'gemini-flash-lite');
    assert.deepEqual(parseArgs(['--only', 'jev']), { repeats: 2, concurrency: 4, baseline: 'unknown', only: 'jev' });
    assert.throws(() => parseOnly('gemini'), /--only must be one of/);
  });
  test('Gemini provider accepts an explicit pinned model', () => {
    assert.equal(createGeminiProvider({ model: GEMINI_FLASH_LITE_MODEL }).model, GEMINI_FLASH_LITE_MODEL);
    assert.equal(createGeminiProvider(GEMINI_FLASH_LITE_MODEL).model, GEMINI_FLASH_LITE_MODEL);
  });
  test('Gemini and Jev both traverse stage 1 then stage 2 for a dynamic fixture', async () => {
    const geminiCalls: number[] = [];
    const jevCalls: string[][] = [];
    const geminiStages: ModelCallOptions['stage'][] = [];
    const jevStages: ModelCallOptions['stage'][] = [];

    const gemini = await classifyFixture(recordStages(geminiProvider(geminiCalls), geminiStages), dynamicFixture, 1);
    const jev = await classifyFixture(recordStages(jevProvider(jevCalls), jevStages), dynamicFixture, 1);

    assert.equal(gemini.actual, 'block');
    assert.equal(jev.actual, 'block');
    assert.equal(gemini.stage, 'stage2');
    assert.equal(jev.stage, 'stage2');
    assert.deepEqual(geminiCalls, [STAGE1_MAX_OUTPUT_TOKENS, STAGE2_MAX_OUTPUT_TOKENS]);
    assert.deepEqual(jevCalls, [['ALLOW', 'BLOCK'], ['ALLOW', 'ASK', 'BLOCK']]);
    assert.deepEqual(geminiStages, ['stage1', 'stage2']);
    assert.deepEqual(jevStages, ['stage1', 'stage2']);
  });

  test('Gemini and Jev make no model calls for a static fixture', async () => {
    const geminiCalls: number[] = [];
    const jevCalls: string[][] = [];
    const geminiStages: ModelCallOptions['stage'][] = [];
    const jevStages: ModelCallOptions['stage'][] = [];

    const gemini = await classifyFixture(recordStages(geminiProvider(geminiCalls), geminiStages), staticFixture, 1);
    const jev = await classifyFixture(recordStages(jevProvider(jevCalls), jevStages), staticFixture, 1);

    assert.equal(gemini.stage, 'static');
    assert.equal(jev.stage, 'static');
    assert.equal(gemini.latencyClass, 'static');
    assert.equal(jev.latencyClass, 'static');
    assert.deepEqual(geminiCalls, []);
    assert.deepEqual(jevCalls, []);
    assert.deepEqual(geminiStages, []);
    assert.deepEqual(jevStages, []);
  });

  test('provider failures are errors rather than safety decisions', async () => {
    const provider: ProviderAdapter = {
      provider: 'gemini',
      model: 'test-model',
      createSession() {
        let calls = 0;
        return {
          async call() {
            calls += 1;
            throw new Error('provider unavailable');
          },
          snapshot: () => ({
            inputTokens: 0,
            outputTokens: 0,
            modelCallDurationMs: 0,
            modelCallCount: calls,
          confidences: [],
          errors: Array.from({ length: calls }, () => 'provider unavailable'),
          answers: [],
          }),
        };
      },
    };

    const result = await classifyFixture(provider, dynamicFixture, 1);
    assert.equal(result.actual, null);
    assert.equal(result.pass, null);
    assert.equal(result.expectedBlockMiss, null);
    assert.equal(result.providerError?.count, 4);
    assert.equal(result.modelCallCount, 4);
  });

  test('sorts output by repeat, paired provider order, then fixture ID', () => {
    const result = (
      repeat: number,
      provider: BenchmarkComparisonResult['provider'],
      id: string,
    ): BenchmarkComparisonResult => ({
      provider,
      repeat,
      id,
      category: 'test',
      expected: 'allow',
      actual: 'allow',
      pass: true,
      expectedBlockMiss: false,
      providerError: null,
      stage: 'static',
      latencyClass: 'static',
      durationMs: 0,
      modelCallDurationMs: 0,
      modelCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      answers: [],
    });
    const values = [
      result(2, 'jev', 'b'),
      result(1, 'jev', 'b'),
      result(1, 'gemini', 'b'),
      result(1, 'gemini', 'a'),
      result(2, 'gemini', 'a'),
    ];

    values.sort(compareBenchmarkResults);
    assert.deepEqual(values.map(({ repeat, provider, id }) => `${repeat}:${provider}:${id}`), [
      '1:gemini:a',
      '1:gemini:b',
      '1:jev:b',
      '2:gemini:a',
      '2:jev:b',
    ]);
  });
});
