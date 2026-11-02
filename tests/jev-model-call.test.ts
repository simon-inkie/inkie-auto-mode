import { afterEach, beforeEach, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createJevModelCall, type JevClient } from '../core/jev-model-call.js';
import { DEFAULT_CONFIG, type ModelCallOptions } from '../core/types.js';
import { classify } from '../core/classifier.js';
import { modelCall as claudeCall } from '../adapters/claude-code/src/model-call.js';
import { modelCall as cursorCall } from '../adapters/cursor/src/model-call.js';
import { createModelCall } from '../adapters/openclaw/src/plugin.js';

const opts: ModelCallOptions = {
  model: 'typesafe/jev-1.13.0', stage: 'stage1', system: 'security policy',
  messages: [{ role: 'user', content: 'proposed-action' }], maxTokens: 1024, temperature: 0,
};
const answer = (choice: string, probabilities: Record<string, number>) => ({
  answers: { decision: { type: 'choice', choice, probabilities, confidence: 0.9 } },
});
const clientFor = (value: unknown): JevClient => ({ async systemOne() { return value as Awaited<ReturnType<JevClient['systemOne']>>; } });
let originalKey: string | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => { originalKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic-test-key'; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

describe('Jev primary model transport', () => {
  test('defaults select Jev at both stages and fallbacks', () => {
    for (const key of ['stage1Model', 'stage1Fallback', 'stage2Model', 'stage2Fallback'] as const) {
      assert.equal(DEFAULT_CONFIG[key], opts.model);
    }
  });
  test('sends the full policy/input and disables retries', async () => {
    const call = createJevModelCall(() => ({ async systemOne(request, options) {
      const body = request as { model: string; state: string; questions: { decision: unknown } };
      assert.equal(body.model, 'jev-1.13.0');
      assert.deepEqual(JSON.parse(body.state).messages, opts.messages);
      assert.match(JSON.stringify(body.questions), /security policy/);
      assert.equal(options.retry.maxRetries, 0);
      assert.ok(options.signal instanceof AbortSignal);
      return answer('BLOCK', { ALLOW: 0.86, BLOCK: 0.14 });
    } }));
    assert.equal(await call(opts), 'ALLOW');
  });
  test('escalates below the stage 1 threshold, then prioritises BLOCK in stage 2', async () => {
    const seen: string[] = [];
    const call = createJevModelCall(() => ({ async systemOne(request) {
      const body = request as { questions: { decision: { criteria: Record<string, string> } } };
      const stage2 = 'ASK' in body.questions.decision.criteria;
      seen.push(stage2 ? 'stage2' : 'stage1');
      return stage2 ? answer('ALLOW', { ALLOW: 0.8, ASK: 0.1, BLOCK: 0.1 }) : answer('ALLOW', { ALLOW: 0.85, BLOCK: 0.15 });
    } }));
    const result = await classify('custom-action', [], call, DEFAULT_CONFIG);
    assert.equal(result.decision, 'block');
    assert.equal(result.model, opts.model);
    assert.deepEqual(seen, ['stage1', 'stage2']);
  });
  test('stage 2 returns ASK and ALLOW at the respective thresholds', async () => {
    const call = createJevModelCall(() => clientFor(answer('ASK', { ALLOW: 0.6, ASK: 0.32, BLOCK: 0.08 })));
    assert.equal(JSON.parse(await call({ ...opts, stage: 'stage2' })).decision, 'ASK');
    const allowed = createJevModelCall(() => clientFor(answer('ASK', { ALLOW: 0.61, ASK: 0.31, BLOCK: 0.08 })));
    assert.equal(JSON.parse(await allowed({ ...opts, stage: 'stage2' })).decision, 'ALLOW');
  });
  test('rejects missing, non-finite and incomplete probability data', async () => {
    for (const value of [null, answer('ALLOW', {}), answer('ALLOW', { ALLOW: NaN, BLOCK: 0.1 }), answer('ALLOW', { ALLOW: 0.99 }), answer('ASK', { ALLOW: 0.9, BLOCK: 0.1 })]) {
      await assert.rejects(createJevModelCall(() => clientFor(value))(opts), /request failed/);
    }
  });
  test('rejects non-Choice payloads and extra stage labels', async () => {
    const nonChoice = answer('ALLOW', { ALLOW: 0.9, BLOCK: 0.1 });
    nonChoice.answers.decision.type = 'score';
    for (const value of [nonChoice, answer('ALLOW', { ALLOW: 0.9, BLOCK: 0.1, ASK: 1 })]) {
      await assert.rejects(createJevModelCall(() => clientFor(value))(opts), /request failed/);
    }
  });
  test('missing credential and unsupported model never construct a client', async () => {
    let constructed = false;
    const call = createJevModelCall(() => { constructed = true; throw new Error('unexpected'); });
    delete process.env.TYPESAFE_API_KEY;
    await assert.rejects(call(opts), /Missing TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = 'synthetic-test-key';
    await assert.rejects(call({ ...opts, model: 'typesafe/other' }), /Unsupported Jev model/);
    assert.equal(constructed, false);
  });
  test('deadline rejects even if the transport ignores cancellation', async () => {
    let signal: AbortSignal | undefined;
    const call = createJevModelCall(() => ({ systemOne(_request, options) {
      signal = options.signal;
      return new Promise(() => undefined);
    } }), 10);
    await assert.rejects(call(opts), /timed out/);
    assert.equal(signal?.aborted, true);
  });
  test('provider failures cannot leak raw errors and preserve existing error decisions', async () => {
    const call = createJevModelCall(() => ({ async systemOne() { throw new Error('SYNTHETIC-PRIVATE-REQUEST'); } }));
    await assert.rejects(call(opts), error => error instanceof Error && error.message === 'Jev classifier request failed');
    assert.equal((await classify('custom-action', [], call, DEFAULT_CONFIG)).decision, 'ask');
    assert.equal((await classify('custom-action', [], call, DEFAULT_CONFIG, { isMainSession: false })).decision, 'block');
  });
  test('Claude, Cursor and OpenClaw route Jev through SDK without Google auth', async () => {
    let requests = 0;
    globalThis.fetch = (async (_url, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'jev-1.13.0');
      return new Response(JSON.stringify(answer('ALLOW', { ALLOW: 0.9, BLOCK: 0.1 })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const openclaw = createModelCall({ config: {}, runtime: { modelAuth: { resolveApiKeyForProvider() { throw new Error('auth must not run'); } } } } as unknown as Parameters<typeof createModelCall>[0]);
    for (const call of [claudeCall, cursorCall, openclaw]) assert.equal(await call(opts), 'ALLOW');
    assert.equal(requests, 3);
  });
});
