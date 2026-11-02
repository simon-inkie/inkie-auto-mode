import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../core/classifier.js';
import {
  JEV_SHADOW_MAX_BYTES,
  appendJevShadowEvent,
  createJevShadowDispatcher,
  createScheduledEvent,
  type JevShadowCompletedEvent,
} from '../core/jev-shadow.js';
import { executeJevShadow, type JevShadowClient } from '../core/jev-shadow-worker.js';
import { JEV_THRESHOLDED_A, thresholdedADecision, validateJevChoice } from '../core/jev-policy.js';
import { DEFAULT_CONFIG, mergeClassifierConfig, type ShadowJob } from '../core/types.js';
import { summariseJevShadowJsonl } from '../scripts/summarise-jev-shadow.js';

const GEMINI_CONFIG = { ...DEFAULT_CONFIG, stage1Model: 'google/gemini-3.8-flash', stage1Fallback: 'google/gemini-3.8-flash', stage2Model: 'google/gemini-3.8-flash', stage2Fallback: 'google/gemini-3.8-flash' };

function tempLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'jev-shadow-')), 'shadow.jsonl');
}

function job(decision: 'allow' | 'ask' | 'block' = 'allow'): ShadowJob {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    actionKind: 'shell',
    systemPrompt: 'SECRET-SYSTEM-CANARY',
    userMessage: 'SECRET-REQUEST-CANARY',
    gemini: { decision, stage: 'stage1', model: 'google/gemini-3.8-flash' },
  };
}

function response(choice: string, probabilities: Record<string, number>, confidence = 0.9) {
  return { answers: { decision: { type: 'choice', choice, probabilities, confidence } } };
}

function readEvents(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function awaitWithKeepAlive<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 100);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

describe('Jev shadow policy and configuration', () => {
  test('is disabled by default and malformed nested config fails disabled', () => {
    assert.equal(DEFAULT_CONFIG.jevShadow.enabled, false);
    assert.equal(mergeClassifierConfig({ jevShadow: true }).jevShadow.enabled, false);
    assert.equal(mergeClassifierConfig({ jevShadow: { enabled: 'yes' } }).jevShadow.enabled, false);
    assert.equal(mergeClassifierConfig({ jevShadow: { enabled: true } }).jevShadow.enabled, true);
  });

  test('pins exact threshold boundaries and BLOCK precedence', () => {
    assert.deepEqual(JEV_THRESHOLDED_A, { stage1Allow: 0.86, stage2Allow: 0.61, stage2Block: 0.09 });
    assert.equal(thresholdedADecision('stage1', { ALLOW: 0.86 }), 'ALLOW');
    assert.equal(thresholdedADecision('stage1', { ALLOW: 0.859 }), 'BLOCK');
    assert.equal(thresholdedADecision('stage2', { ALLOW: 0.9, BLOCK: 0.09 }), 'BLOCK');
    assert.equal(thresholdedADecision('stage2', { ALLOW: 0.61, BLOCK: 0.089 }), 'ALLOW');
    assert.equal(thresholdedADecision('stage2', { ALLOW: 0.609, BLOCK: 0.089 }), 'ASK');
  });

  test('validates and zero-fills typed Choice values', () => {
    assert.deepEqual(validateJevChoice({ choice: 'allow', confidence: 0.8, probabilities: { ALLOW: 0.8, BLOCK: 0.2 } }), {
      choice: 'ALLOW', confidence: 0.8, probabilities: { ALLOW: 0.8, ASK: 0, BLOCK: 0.2 },
    });
    assert.throws(() => validateJevChoice({ choice: 'ALLOW', confidence: 2, probabilities: {} }));
    assert.throws(() => validateJevChoice({ choice: 'MAYBE', confidence: 0.5, probabilities: {} }));
  });
});

describe('Gemini enforcement remains authoritative', () => {
  test('dynamic success dispatches once without changing the Gemini result', async () => {
    const jobs: ShadowJob[] = [];
    const enabled = { dispatch: (value: ShadowJob) => jobs.push(value) };
    const disabled = await classify('custom-command', [], async () => 'ALLOW', GEMINI_CONFIG);
    const shadowed = await classify('custom-command', [], async () => 'ALLOW', GEMINI_CONFIG, { shadowDispatcher: enabled });
    assert.deepEqual({ ...shadowed, durationMs: 0 }, { ...disabled, durationMs: 0 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].gemini.decision, 'allow');
    assert.equal(jobs[0].gemini.stage, 'stage1');
  });

  test('static and classifier-error decisions are ineligible', async () => {
    let dispatches = 0;
    const dispatcher = { dispatch: () => { dispatches += 1; } };
    await classify('pwd', [], async () => 'ALLOW', GEMINI_CONFIG, { shadowDispatcher: dispatcher });
    await classify('custom-command', [], async () => { throw new Error('provider'); }, GEMINI_CONFIG, { shadowDispatcher: dispatcher });
    assert.equal(dispatches, 0);
  });

  test('a dispatcher failure cannot alter or reject Gemini enforcement', async () => {
    const result = await classify('custom-command', [], async (options) => options.stage === 'stage1'
      ? 'BLOCK'
      : JSON.stringify({ thinking: '', decision: 'BLOCK', reason: 'unsafe' }), GEMINI_CONFIG, {
      shadowDispatcher: { dispatch: () => { throw new Error('shadow failure'); } },
    });
    assert.equal(result.decision, 'block');
    assert.equal(result.stage, 'stage2');
  });

  for (const scenario of [
    {
      name: 'Jev mismatch',
      client: {
        async systemOne() { return response('ALLOW', { ALLOW: 0.9, ASK: 0.05, BLOCK: 0.05 }); },
      } satisfies JevShadowClient,
      timeoutMs: 50,
      status: 'ok',
    },
    {
      name: 'Jev timeout',
      client: { systemOne: () => new Promise<never>(() => undefined) } satisfies JevShadowClient,
      timeoutMs: 5,
      status: 'timeout',
    },
    {
      name: 'Jev provider error',
      client: {
        async systemOne() { throw new Error('unavailable'); },
      } satisfies JevShadowClient,
      timeoutMs: 50,
      status: 'provider_error',
    },
  ] as const) {
    test(`${scenario.name} cannot change the Gemini decision`, async () => {
      const path = tempLog();
      let terminal: Promise<void> | undefined;
      const result = await classify('custom-command', [], async (options) => options.stage === 'stage1'
        ? 'BLOCK'
        : JSON.stringify({ thinking: '', decision: 'BLOCK', reason: 'Gemini block' }), GEMINI_CONFIG, {
        shadowDispatcher: {
          dispatch(value) {
            terminal = executeJevShadow({ ...value, logPath: path }, scenario.client, scenario.timeoutMs);
          },
        },
      });
      assert.equal(result.decision, 'block');
      assert.equal(result.reason, 'Gemini block');
      assert.ok(terminal);
      await awaitWithKeepAlive(terminal);
      const event = readEvents(path)[0] as unknown as JevShadowCompletedEvent;
      assert.equal(event.jev.status, scenario.status);
    });
  }
});

describe('detached dispatch and terminal telemetry', () => {
  test('disabled dispatcher performs no spawn or file creation', () => {
    const path = tempLog();
    let spawns = 0;
    const dispatcher = createJevShadowDispatcher({
      config: DEFAULT_CONFIG,
      workerUrl: new URL('file:///worker.js'),
      logPath: path,
      spawnWorker: () => { spawns += 1; return new EventEmitter() as never; },
    });
    assert.equal(dispatcher, undefined);
    assert.equal(spawns, 0);
  });

  test('spawn receives request only on stdin and environment only carries the credential', () => {
    const path = tempLog();
    let capturedInput = '';
    let capturedEnvironment: NodeJS.ProcessEnv = {};
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end(input: string): void } };
    child.stdin = Object.assign(new EventEmitter(), { end(input: string) { capturedInput = input; } });
    const dispatcher = createJevShadowDispatcher({
      config: { ...DEFAULT_CONFIG, jevShadow: { enabled: true } },
      workerUrl: new URL('file:///worker.js'),
      logPath: path,
      environment: { TYPESAFE_API_KEY: 'SECRET-KEY-CANARY', OTHER_SECRET: 'NOPE' },
      spawnWorker: (_url, environment) => {
        capturedEnvironment = environment;
        return child as never;
      },
    })!;
    dispatcher.dispatch(job());
    assert.match(capturedInput, /SECRET-REQUEST-CANARY/);
    assert.deepEqual(capturedEnvironment, { TYPESAFE_API_KEY: 'SECRET-KEY-CANARY' });
    const persisted = readFileSync(path, 'utf8');
    assert.doesNotMatch(persisted, /SECRET-(?:REQUEST|SYSTEM|KEY)-CANARY/);
    assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ['correlationId', 'event', 'gemini', 'schemaVersion', 'ts']);
  });

  test('success and mismatch are telemetry-only', async () => {
    const agreePath = tempLog();
    const agreeJob = { ...job('allow'), logPath: agreePath };
    appendJevShadowEvent(agreePath, createScheduledEvent(agreeJob));
    await executeJevShadow(agreeJob, {
      async systemOne() { return response('ALLOW', { ALLOW: 0.9, ASK: 0.05, BLOCK: 0.05 }); },
    });
    const agree = readEvents(agreePath)[1] as unknown as JevShadowCompletedEvent;
    assert.equal(agree.jev.proposedDecision, 'allow');
    assert.equal(agree.drift, 'agree');

    const mismatchPath = tempLog();
    const mismatchJob = { ...job('block'), logPath: mismatchPath };
    let calls = 0;
    await executeJevShadow(mismatchJob, {
      async systemOne() {
        calls += 1;
        return calls === 1
          ? response('BLOCK', { ALLOW: 0.2, ASK: 0, BLOCK: 0.8 })
          : response('ALLOW', { ALLOW: 0.8, ASK: 0.15, BLOCK: 0.05 });
      },
    });
    const mismatch = readEvents(mismatchPath)[0] as unknown as JevShadowCompletedEvent;
    assert.equal(calls, 2);
    assert.equal(mismatch.jev.proposedDecision, 'allow');
    assert.equal(mismatch.drift, 'jev_more_permissive');
  });

  test('timeout and provider failure produce unavailable terminal records', async () => {
    const timeoutPath = tempLog();
    await awaitWithKeepAlive(executeJevShadow({ ...job(), logPath: timeoutPath }, {
      systemOne: () => new Promise(() => undefined),
    }, 5));
    const timeout = readEvents(timeoutPath)[0] as unknown as JevShadowCompletedEvent;
    assert.equal(timeout.jev.status, 'timeout');
    assert.equal(timeout.jev.proposedDecision, null);
    assert.equal(timeout.drift, 'unavailable');

    const errorPath = tempLog();
    await executeJevShadow({ ...job(), logPath: errorPath }, {
      async systemOne() { throw new Error('provider leaked SECRET-ERROR-CANARY'); },
    } as JevShadowClient);
    const persisted = readFileSync(errorPath, 'utf8');
    assert.doesNotMatch(persisted, /SECRET-ERROR-CANARY|SECRET-REQUEST-CANARY|SECRET-SYSTEM-CANARY/);
    assert.equal((JSON.parse(persisted) as JevShadowCompletedEvent).jev.status, 'provider_error');
  });
});

describe('local summary and retention', () => {
  test('summarises allowlisted fields and tolerates orphan and malformed records', () => {
    const extraSecret = 'SECRET-SUMMARY-CANARY';
    const text = [
      JSON.stringify({ ...createScheduledEvent(job()), request: extraSecret }),
      JSON.stringify({ schemaVersion: 1, event: 'scheduled', ts: 'x', correlationId: 'orphan', gemini: { decision: 'block', stage: 'stage2' }, request: extraSecret }),
      JSON.stringify({ schemaVersion: 1, event: 'completed', ts: 'x', correlationId: job().correlationId, gemini: { decision: 'allow', stage: 'stage1' }, jev: { status: 'ok', stages: [{ stage: 'stage1', request: extraSecret }], proposedDecision: 'allow', latencyMs: 10 }, drift: 'agree', request: extraSecret }),
      JSON.stringify({ schemaVersion: 1, event: 'completed', ts: 'x', correlationId: 'terminal-only', gemini: { decision: 'block', stage: 'stage2' }, jev: { status: 'provider_error', stages: [], proposedDecision: null, latencyMs: 20 }, drift: 'unavailable' }),
      '{bad',
    ].join('\n');
    const summary = summariseJevShadowJsonl(text);
    assert.equal(summary.eligible, 3);
    assert.equal(summary.scheduled, 2);
    assert.equal(summary.completed, 2);
    assert.equal(summary.orphanScheduled, 1);
    assert.equal(summary.orphanCompleted, 1);
    assert.equal(summary.malformedLines, 1);
    assert.equal(summary.agreement.agree, 1);
    assert.equal(summary.jevStatus.provider_error, 1);
    assert.equal(summary.jevErrorRate, 0.5);
    assert.deepEqual(summary.latencyMs, { p50: 10, p95: 20 });
    assert.doesNotMatch(JSON.stringify(summary), /SECRET-SUMMARY-CANARY/);
  });

  test('rotates a full active log before appending', () => {
    const path = tempLog();
    writeFileSync(path, '');
    truncateSync(path, JEV_SHADOW_MAX_BYTES);
    appendJevShadowEvent(path, createScheduledEvent(job()));
    assert.equal(statSync(`${path}.1`).size, JEV_SHADOW_MAX_BYTES);
    assert.ok(statSync(path).size > 0);
  });
});
