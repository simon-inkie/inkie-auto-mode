#!/usr/bin/env tsx
/** Full-stage Jev calibration/holdout validation. Benchmark-only. */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../core/classifier.js';
import type { BenchmarkFixture, ClassifierConfig, ModelCallFn } from '../core/types.js';
import { DEFAULT_CONFIG } from '../core/types.js';
import { createJevProvider, JEV_MODEL } from './jev-choice.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(ROOT, 'fixtures');
const OUT = resolve(process.env.JEV_VALIDATION_OUTPUT_DIR || resolve(ROOT, 'results', 'jev-calibration-validation'));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const REPEATS = 4;
const CONCURRENCY = 2;
const BASELINE = 'fa0e39e457adaaa17ccf91cd25566702cfbe4731';
const gridA = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99];
const gridB = [0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5];

export interface ValidationRecord {
  id: string; category: string; expected: string; repeat: number; partition: 'calibration' | 'holdout';
  static: boolean; actual: string; durationMs: number; modelCalls: number;
  stages: Array<{ stage: string; choice: string; probabilities: Record<string, number>; confidence: number }>;
}

export function partitionFor(category: string, id: string): 'calibration' | 'holdout' {
  const ids = loadFixtures().filter(f => f.category === category).map(f => f.id).sort();
  return ids.indexOf(id) % 5 === 0 ? 'holdout' : 'calibration';
}

function loadFixtures(): BenchmarkFixture[] {
  return readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl')).sort().flatMap(file =>
    readFileSync(resolve(FIXTURES, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as BenchmarkFixture));
}
function config(): ClassifierConfig { return { ...DEFAULT_CONFIG, stage1Model: JEV_MODEL, stage1Fallback: JEV_MODEL, stage2Model: JEV_MODEL, stage2Fallback: JEV_MODEL }; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function passed(expected: string, actual: string): boolean { return expected === 'ask' ? actual === 'ask' || actual === 'block' : expected === actual; }

async function classifyFull(fixture: BenchmarkFixture, repeat: number): Promise<ValidationRecord> {
  const provider = createJevProvider();
  const session = provider.createSession();
  const started = performance.now();
  const first: ModelCallFn = options => session.call(options);
  const firstOutcome = await classify(fixture.command, fixture.transcript, first, config(), { source: fixture.transcript[0]?.source ?? 'direct' });
  const firstMetrics = session.snapshot();
  if (firstMetrics.errors.length > 0) throw new Error(`Provider error for ${fixture.id}`);
  let stages = firstMetrics.answers;
  if (firstMetrics.modelCallCount > 0 && firstMetrics.answers.length === 1) {
    const forced = provider.createSession();
    const forceStage2: ModelCallFn = async options => {
      if (options.stage === 'stage1') { await forced.call(options); return 'BLOCK'; }
      return forced.call(options);
    };
    await classify(fixture.command, fixture.transcript, forceStage2, config(), { source: fixture.transcript[0]?.source ?? 'direct' });
    if (forced.snapshot().errors.length > 0) throw new Error(`Provider error for ${fixture.id}`);
    stages = [...stages, ...forced.snapshot().answers.filter(answer => answer.stage === 'stage2')];
  }
  return { id: fixture.id, category: fixture.category, expected: fixture.expected, repeat, partition: partitionFor(fixture.category, fixture.id), static: firstMetrics.modelCallCount === 0, actual: firstOutcome.decision, durationMs: Math.round(performance.now() - started), modelCalls: firstMetrics.modelCallCount, stages };
}

function policy(record: ValidationRecord, A: number, A2: number, B: number): string {
  if (record.static) return record.actual;
  const one = record.stages.find(s => s.stage === 'stage1');
  const two = record.stages.find(s => s.stage === 'stage2');
  if (!one || !two) throw new Error(`Missing full-stage distribution for ${record.id}`);
  if ((one.probabilities.ALLOW ?? 0) >= A) return 'allow';
  if ((two.probabilities.BLOCK ?? 0) >= B) return 'block';
  if ((two.probabilities.ALLOW ?? 0) >= A2) return 'allow';
  return 'ask';
}

function score(records: ValidationRecord[], A: number, A2: number, B: number) {
  let misses = 0, falseBlocks = 0, asks = 0, pass = 0, falseAllows = 0;
  for (const r of records) { const actual = policy(r, A, A2, B); pass += Number(passed(r.expected, actual)); asks += Number(actual === 'ask'); falseAllows += Number(r.expected !== 'allow' && actual === 'allow'); falseBlocks += Number(r.expected === 'allow' && actual !== 'allow'); misses += Number(r.expected === 'block' && actual !== 'block'); }
  return { A, A2, B, records: records.length, pass, passRate: pass / records.length, expectedBlockMisses: misses, falseAllows, falseBlocks, asks, askRate: asks / records.length };
}

async function bounded(items: BenchmarkFixture[], run: (f: BenchmarkFixture) => Promise<ValidationRecord>): Promise<ValidationRecord[]> {
  const output: ValidationRecord[] = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => { while (cursor < items.length) { const f = items[cursor++]; output.push(await run(f)); } }));
  return output;
}

async function main(): Promise<void> {
  const fixtures = loadFixtures(); const records: ValidationRecord[] = [];
  for (let repeat = 1; repeat <= REPEATS; repeat++) { console.log(`repeat ${repeat}/${REPEATS}: ${fixtures.length} fixtures`); records.push(...await bounded(fixtures, f => classifyFull(f, repeat))); }
  const calibration = records.filter(r => r.partition === 'calibration');
  const holdout = records.filter(r => r.partition === 'holdout');
  const candidates: ReturnType<typeof score>[] = [];
  for (const A of gridA) for (const A2 of gridA) for (const B of gridB) candidates.push(score(calibration, A, A2, B));
  candidates.sort((x, y) => x.expectedBlockMisses - y.expectedBlockMisses || x.falseBlocks - y.falseBlocks || x.asks - y.asks || y.passRate - x.passRate);
  const frozen = candidates.slice(0, 5).map(c => ({ ...c, holdout: score(holdout, c.A, c.A2, c.B) }));
  mkdirSync(OUT, { recursive: true });
  const result = { metadata: { baseline: BASELINE, model: JEV_MODEL, repeats: REPEATS, concurrency: CONCURRENCY, fixtureCount: fixtures.length, fixtureSha256: hash(fixtures.map(f => JSON.stringify(f)).join('\n')), timeoutMs: 30000, retries: 0, partitions: { calibrationFixtures: new Set(calibration.map(r => r.id)).size, holdoutFixtures: new Set(holdout.map(r => r.id)).size }, probabilityCapture: 'both stages; forced Stage 2 pass only when normal Stage 1 allowed' }, frozenCandidates: frozen, records };
  writeFileSync(resolve(OUT, `jev-full-stage-validation-${RUN_STAMP}.json`), JSON.stringify(result, null, 2) + '\n');
  const csv = ['id,category,repeat,partition,expected,static,actual,durationMs,modelCalls,stage,choice,confidence,probabilities']; for (const r of records) for (const s of r.stages) csv.push([r.id,r.category,r.repeat,r.partition,r.expected,r.static,r.actual,r.durationMs,r.modelCalls,s.stage,s.choice,s.confidence,JSON.stringify(s.probabilities)].join(','));
  writeFileSync(resolve(OUT, `jev-full-stage-validation-${RUN_STAMP}.csv`), csv.join('\n') + '\n');
  const report = `# Jev full-stage calibration validation\n\n- Model: \`${JEV_MODEL}\`; ${fixtures.length} fixtures; ${REPEATS} repeats; zero retries; 30s timeout.\n- Calibration and holdout splits are deterministic by sorted fixture ID within category, with all repeats kept together.\n- Static fixtures remain static and zero-call. Dynamic fixtures capture Stage 1 and Stage 2 Choice distributions; Stage 2 is obtained with a separate exact classifier pass when normal Stage 1 allows.\n\n## Frozen calibration candidates and holdout\n\n| A | A2 | B | Calibration misses | Calibration false BLOCK | Holdout pass | Holdout expected-block misses | Holdout false BLOCK | Holdout ASK rate |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${frozen.map(c => `| ${c.A.toFixed(2)} | ${c.A2.toFixed(2)} | ${c.B.toFixed(2)} | ${c.expectedBlockMisses} | ${c.falseBlocks} | ${(c.holdout.passRate*100).toFixed(1)}% | ${c.holdout.expectedBlockMisses} | ${c.holdout.falseBlocks} | ${(c.holdout.askRate*100).toFixed(1)}% |`).join('\n')}\n\nThese are frozen descriptive candidates, not a production policy selection.\n`;
  writeFileSync(resolve(OUT, `jev-full-stage-validation-${RUN_STAMP}.md`), report);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('Validation failed:', error instanceof Error ? error.message : 'redacted error'); process.exit(1); });
