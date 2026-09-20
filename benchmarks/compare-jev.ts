#!/usr/bin/env tsx
/** Reproducible, benchmark-only Gemini versus Jev comparison. */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../core/classifier.js';
import type { BenchmarkFixture, ClassifierConfig, Decision, ModelCallFn } from '../core/types.js';
import { DEFAULT_CONFIG } from '../core/types.js';
import { createGeminiProvider, GEMINI_FLASH_LITE_MODEL, GEMINI_MODEL } from './gemini-session.js';
import { createJevProvider, JEV_MODEL, redactBenchmarkError } from './jev-choice.js';
import type { ProviderAdapter, ProviderName } from './provider-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const RESULTS_DIR = resolve(__dirname, 'results');

interface Args {
  repeats: number;
  concurrency: number;
  baseline: string;
  only: 'gemini-flash' | 'gemini-flash-lite' | 'jev' | 'jev-ab' | 'jev-c' | null;
}

export interface BenchmarkComparisonResult {
  provider: ProviderName;
  repeat: number;
  id: string;
  category: string;
  expected: Decision;
  actual: Decision | null;
  pass: boolean | null;
  expectedBlockMiss: boolean | null;
  providerError: { count: number; messages: string[] } | null;
  stage: string;
  latencyClass: 'static' | 'model';
  durationMs: number;
  modelCallDurationMs: number;
  modelCallCount: number;
  model?: string;
  variant?: string;
  answers: Array<{ choice: string; probabilities: Record<string, number>; confidence: number; stage: string }>;
  confidence?: number;
  usage: { inputTokens: number; outputTokens: number };
}

export function parseOnly(value: string): Args['only'] {
  if (value === 'gemini-flash' || value === 'gemini-flash-lite' || value === 'jev' || value === 'jev-ab' || value === 'jev-c') return value;
  throw new Error(`--only must be one of: gemini-flash, gemini-flash-lite, jev, jev-ab, jev-c (received ${value})`);
}

export function parseArgs(values = process.argv.slice(2)): Args {
  let repeats = 2;
  let concurrency = 4;
  let baseline = process.env.GITHUB_SHA ?? 'unknown';
  let only: Args['only'] = null;
  for (let index = 0; index < values.length; index += 1) {
    switch (values[index]) {
      case '--repeats': repeats = Number(values[++index]); break;
      case '--concurrency': concurrency = Number(values[++index]); break;
      case '--baseline': baseline = values[++index] ?? baseline; break;
      case '--only': only = parseOnly(values[++index] ?? ''); break;
      case '--help':
        console.log('Usage: pnpm benchmark:jev -- [--only gemini-flash|gemini-flash-lite|jev|jev-ab|jev-c] [--repeats 2] [--concurrency 4] [--baseline <public-commit>]');
        process.exit(0);
    }
  }
  if (!Number.isInteger(repeats) || repeats < 2) throw new Error('--repeats must be an integer of at least 2');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return { repeats, concurrency, baseline, only };
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function loadFixtures(): { fixtures: BenchmarkFixture[]; hash: string } {
  const files = readdirSync(FIXTURES_DIR).filter((file) => file.endsWith('.jsonl')).sort();
  const corpus = files.map((file) => `${file}\n${readFileSync(resolve(FIXTURES_DIR, file), 'utf8')}`).join('\n');
  const fixtures = files.flatMap((file) => readFileSync(resolve(FIXTURES_DIR, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BenchmarkFixture));
  return { fixtures, hash: hash(corpus) };
}

function passed(expected: Decision, actual: Decision): boolean {
  return expected === 'ask' ? actual === 'ask' || actual === 'block' : expected === actual;
}

function providerErrorKind(message: string): string {
  if (/timed out/i.test(message)) return 'timeout';
  if (/no visible text/i.test(message)) return 'empty-visible-output';
  const httpStatus = message.match(/API error (\d{3})/i)?.[1];
  if (httpStatus) return `http-${httpStatus}`;
  if (/fetch failed|network|econn|enotfound|socket/i.test(message)) return 'network';
  return 'other-redacted-provider-error';
}

export function compareBenchmarkResults(
  left: BenchmarkComparisonResult,
  right: BenchmarkComparisonResult,
): number {
  const providerOrder: Record<ProviderName, number> = { gemini: 0, jev: 1 };
  const geminiModelOrder: Record<string, number> = {
    [GEMINI_MODEL]: 0,
    [GEMINI_FLASH_LITE_MODEL]: 1,
  };
  return left.repeat - right.repeat
    || providerOrder[left.provider] - providerOrder[right.provider]
    || (left.provider === 'gemini' && right.provider === 'gemini'
      ? (geminiModelOrder[left.model ?? ''] ?? Number.MAX_SAFE_INTEGER)
        - (geminiModelOrder[right.model ?? ''] ?? Number.MAX_SAFE_INTEGER)
      : 0)
    || left.id.localeCompare(right.id);
}

function configFor(model: string): ClassifierConfig {
  return {
    ...DEFAULT_CONFIG,
    stage1Model: model,
    stage1Fallback: model,
    stage2Model: model,
    stage2Fallback: model,
  };
}

/** The runner owns this one classifier orchestration for every provider. */
export async function classifyFixture(
  provider: ProviderAdapter,
  fixture: BenchmarkFixture,
  repeat: number,
): Promise<BenchmarkComparisonResult> {
  const session = provider.createSession();
  const started = performance.now();
  const modelCall: ModelCallFn = (options) => session.call(options);
  const outcome = await classify(
    fixture.command,
    fixture.transcript,
    modelCall,
    configFor(provider.model),
    { source: fixture.transcript[0]?.source ?? 'direct' },
  );
  const durationMs = Math.round(performance.now() - started);
  const metrics = session.snapshot();
  const providerError = metrics.errors.length > 0 || outcome.stage === 'error'
    ? {
        count: Math.max(metrics.errors.length, 1),
        messages: metrics.errors.length > 0 ? metrics.errors : [outcome.reason ?? 'Classifier models unavailable'],
      }
    : null;
  const actual = providerError === null ? outcome.decision : null;

  return {
    provider: provider.provider,
    repeat,
    id: fixture.id,
    category: fixture.category,
    expected: fixture.expected,
    actual,
    pass: actual === null ? null : passed(fixture.expected, actual),
    expectedBlockMiss: actual === null ? null : fixture.expected === 'block' && actual !== 'block',
    providerError,
    stage: outcome.stage,
    latencyClass: metrics.modelCallCount === 0 ? 'static' : 'model',
    durationMs,
    modelCallDurationMs: metrics.modelCallDurationMs,
    modelCallCount: metrics.modelCallCount,
    model: provider.model,
    variant: provider.variant,
    answers: metrics.answers,
    confidence: metrics.confidences.length > 0
      ? metrics.confidences.reduce((sum, value) => sum + value, 0) / metrics.confidences.length
      : undefined,
    usage: { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens },
  };
}

async function runBounded(
  items: readonly BenchmarkFixture[],
  concurrency: number,
  run: (item: BenchmarkFixture) => Promise<BenchmarkComparisonResult>,
): Promise<BenchmarkComparisonResult[]> {
  const results: BenchmarkComparisonResult[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.push(await run(item));
    }
  }));
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { fixtures, hash: fixtureHash } = loadFixtures();
  const allProviders: ProviderAdapter[] = [
    createGeminiProvider({ model: GEMINI_MODEL }),
    createGeminiProvider({ model: GEMINI_FLASH_LITE_MODEL }),
    createJevProvider(),
    createJevProvider(undefined, 'native'),
    createJevProvider(undefined, 'c'),
  ];
  const providers = args.only === null ? allProviders.slice(0, 3) : allProviders.filter((provider) =>
    args.only === 'jev-ab' ? provider.provider === 'jev' && provider.variant !== 'c' :
    args.only === 'jev-c' ? provider.provider === 'jev' && provider.variant === 'c' :
      args.only === 'jev' ? provider.provider === 'jev' && provider.variant === 'current' :
      args.only === 'gemini-flash' ? provider.model === GEMINI_MODEL :
        provider.model === GEMINI_FLASH_LITE_MODEL);
  const results: BenchmarkComparisonResult[] = [];

  for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    for (const provider of providers) {
      console.log(`${provider.provider} repeat ${repeat}/${args.repeats}: ${fixtures.length} fixtures`);
      const providerResults = await runBounded(
        fixtures,
        args.concurrency,
        (fixture) => classifyFixture(provider, fixture, repeat),
      );
      results.push(...providerResults);
      const providerErrorCount = providerResults.filter((result) => result.providerError !== null).length;
      if (providerErrorCount > 0) {
        const errorKinds = [...new Set(providerResults.flatMap((result) =>
          result.providerError?.messages.map(providerErrorKind) ?? []))].sort();
        throw new Error(
          `${provider.provider} ${provider.model} repeat ${repeat} emitted ${providerErrorCount} provider-error records (${errorKinds.join(', ')})`,
        );
      }
    }
  }

  results.sort(compareBenchmarkResults);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const output = resolve(RESULTS_DIR, `ink-923-jev-vs-gemini-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(output, `${JSON.stringify({
    metadata: {
      publicBaseline: args.baseline,
      fixtureCount: fixtures.length,
      fixtureSha256: fixtureHash,
      models: providers.map(({ provider, model, variant }) => ({ provider, model, variant: variant ?? 'default' })),
      promptSha256: { sharedClassifierSystem: hash(readFileSync(resolve(__dirname, '..', 'prompts', 'system.txt'))) },
      repeats: args.repeats,
      providerContract: 'shared-full-two-stage-classifier',
      temperatureSemantics: {
        gemini: 'generation-control',
        jev: 'serialised-in-state-only; not a generation control',
      },
      generatedAt: new Date().toISOString(),
    },
    results,
  }, null, 2)}\n`);
  console.log(`Results written to ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Benchmark failed: ${redactBenchmarkError(error)}`);
    process.exit(1);
  });
}
