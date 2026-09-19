#!/usr/bin/env tsx
/**
 * Reproducible, benchmark-only Gemini versus Jev comparison.
 *
 * Usage (the caller supplies credentials through its environment):
 *   pnpm benchmark:jev -- --repeats 2
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../core/classifier.js';
import type { BenchmarkFixture, ClassifierConfig, Decision, ModelCallFn } from '../core/types.js';
import { DEFAULT_CONFIG } from '../core/types.js';
import { createJevChoiceAdapter, JEV_MODEL, redactBenchmarkError } from './jev-choice.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const RESULTS_DIR = resolve(__dirname, 'results');
const GEMINI_MODEL = 'google/gemini-3.8-flash';
const PROVIDER_TIMEOUT_MS = 20_000;

interface Args {
  repeats: number;
  concurrency: number;
  baseline: string;
}

interface Result {
  provider: 'gemini' | 'jev';
  repeat: number;
  id: string;
  category: string;
  expected: Decision;
  actual: Decision;
  pass: boolean;
  expectedBlockMiss: boolean;
  stage: string;
  durationMs: number;
  model?: string;
  confidence?: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

function parseArgs(): Args {
  let repeats = 2;
  let concurrency = 4;
  let baseline = process.env.GITHUB_SHA ?? 'unknown';
  const values = process.argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    switch (values[index]) {
      case '--repeats': repeats = Number(values[++index]); break;
      case '--concurrency': concurrency = Number(values[++index]); break;
      case '--baseline': baseline = values[++index] ?? baseline; break;
      case '--help':
        console.log('Usage: pnpm benchmark:jev -- [--repeats 2] [--concurrency 4] [--baseline <public-commit>]');
        process.exit(0);
    }
  }
  if (!Number.isInteger(repeats) || repeats < 2) throw new Error('--repeats must be an integer of at least 2');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return { repeats, concurrency, baseline };
}

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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
  if (expected === 'ask') return actual === 'ask' || actual === 'block';
  return expected === actual;
}

const geminiConfig: ClassifierConfig = {
  ...DEFAULT_CONFIG,
  stage1Model: GEMINI_MODEL,
  stage1Fallback: GEMINI_MODEL,
  stage2Model: GEMINI_MODEL,
  stage2Fallback: GEMINI_MODEL,
};

/** Benchmark-local transport with a hard timeout, so an upstream stall is evidence, not a hang. */
function createTimedGeminiModelCall(): ModelCallFn {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('No Google Gemini API credential is available');

  return async ({ model, system, messages, maxTokens, temperature }) => {
    const modelId = model.replace(/^(google|gemini)\//, '');
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((message) => ({ role: 'user', parts: [{ text: message.content }] })),
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini API error ${response.status}`);
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  };
}

async function classifyGemini(fixture: BenchmarkFixture, repeat: number): Promise<Result> {
  const started = performance.now();
  try {
    const decision = await classify(
      fixture.command,
      fixture.transcript,
      createTimedGeminiModelCall(),
      geminiConfig,
      { source: fixture.transcript[0]?.source ?? 'direct' },
    );
    return {
      provider: 'gemini', repeat, id: fixture.id, category: fixture.category,
      expected: fixture.expected, actual: decision.decision,
      pass: passed(fixture.expected, decision.decision),
      expectedBlockMiss: fixture.expected === 'block' && decision.decision !== 'block',
      stage: decision.stage, durationMs: Math.round(performance.now() - started),
      model: decision.model,
    };
  } catch (error) {
    return {
      provider: 'gemini', repeat, id: fixture.id, category: fixture.category,
      expected: fixture.expected, actual: 'block', pass: passed(fixture.expected, 'block'),
      expectedBlockMiss: false, stage: 'error', durationMs: Math.round(performance.now() - started),
      error: redactBenchmarkError(error),
    };
  }
}

async function runBounded<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<Result>): Promise<Result[]> {
  const results: Result[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.push(await run(item));
    }
  }));
  return results;
}

function promptHashes(): Record<string, string> {
  return {
    geminiSystem: hash(readFileSync(resolve(__dirname, '..', 'prompts', 'system.txt'))),
    jevChoice: hash(readFileSync(resolve(__dirname, 'prompts', 'jev-choice.txt'))),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const { fixtures, hash: fixtureHash } = loadFixtures();
  const jev = createJevChoiceAdapter();
  const results: Result[] = [];

  for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    console.log(`Gemini repeat ${repeat}/${args.repeats}: ${fixtures.length} fixtures`);
    results.push(...await runBounded(fixtures, args.concurrency, (fixture) => classifyGemini(fixture, repeat)));
    console.log(`Jev repeat ${repeat}/${args.repeats}: ${fixtures.length} fixtures`);
    results.push(...await runBounded(fixtures, args.concurrency, async (fixture) => {
      const started = performance.now();
      const result = await jev(fixture);
      return {
        provider: 'jev', repeat, id: fixture.id, category: fixture.category,
        expected: fixture.expected, actual: result.decision,
        pass: passed(fixture.expected, result.decision),
        expectedBlockMiss: fixture.expected === 'block' && result.decision !== 'block',
        stage: result.stage, durationMs: Math.round(performance.now() - started),
        model: result.model, confidence: result.confidence, usage: result.usage, error: result.error,
      };
    }));
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = resolve(RESULTS_DIR, `ink-923-jev-vs-gemini-${timestamp}.json`);
  writeFileSync(output, `${JSON.stringify({
    metadata: {
      publicBaseline: args.baseline,
      fixtureCount: fixtures.length,
      fixtureSha256: fixtureHash,
      models: { gemini: GEMINI_MODEL, jev: JEV_MODEL },
      promptSha256: promptHashes(),
      repeats: args.repeats,
      generatedAt: new Date().toISOString(),
    },
    results,
  }, null, 2)}\n`);
  console.log(`Results written to ${output}`);
}

main().catch((error) => {
  console.error(`Benchmark failed: ${redactBenchmarkError(error)}`);
  process.exit(1);
});
