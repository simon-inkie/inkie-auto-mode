import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createJevProvider,
  JEV_MODEL,
  PROMPT_C_STAGE2_PRECEDENCE,
  redactBenchmarkError,
  type JevSystemOneClient,
} from '../benchmarks/jev-choice.js';
import { STAGE1_MAX_OUTPUT_TOKENS } from '../core/classifier.js';

function clientReturning(selected: string, observedSignals: AbortSignal[] = []): JevSystemOneClient {
  return {
    async systemOne(request, options) {
      assert.equal(request.model, JEV_MODEL);
      const state = JSON.parse(String(request.state)) as {
        outputBudgetTokens: number;
        temperature: number;
      };
      const criterionCount = Object.keys(request.questions.decision.criteria).length;
      assert.equal(state.outputBudgetTokens, criterionCount === 2 ? STAGE1_MAX_OUTPUT_TOKENS : 2048);
      assert.equal(state.temperature, 0);
      if (options?.signal) observedSignals.push(options.signal);
      assert.equal(options?.retry?.maxRetries, 0);
      assert.ok(options?.signal instanceof AbortSignal);
      return {
        model: JEV_MODEL,
        usage: { input_tokens: 17, output_tokens: 2 },
        answers: {
          decision: {
            type: 'choice',
            choice: selected,
            confidence: 0.91,
            probabilities: { ALLOW: 0.91, ASK: 0.04, BLOCK: 0.05 },
          },
        },
      };
    },
  };
}

describe('Jev benchmark provider', () => {
  test('native variant uses pinned Choice criteria and preserves probabilities', async () => {
    let criteria: string[] = [];
    const client: JevSystemOneClient = {
      async systemOne(request) {
        criteria = Object.keys(request.questions.decision.criteria);
        return { model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 1 }, answers: { decision: {
          type: 'choice', choice: 'BLOCK', confidence: 0.8, probabilities: { ALLOW: 0.1, BLOCK: 0.9 },
        } } };
      },
    };
    const session = createJevProvider(() => client, 'native').createSession();
    await session.call({ stage: 'stage1', model: JEV_MODEL, system: 'ignored', messages: [], maxTokens: 1024, temperature: 0 });
    assert.deepEqual(criteria, ['ALLOW', 'BLOCK']);
    assert.deepEqual(session.snapshot().answers[0].probabilities, { ALLOW: 0.1, BLOCK: 0.9 });
  });
  test('prompt C preserves current criteria and adds only the bounded Stage 2 precedence sentence', async () => {
    const captured: string[] = [];
    const client: JevSystemOneClient = {
      async systemOne(request) {
        captured.push(JSON.stringify(request.questions.decision));
        return { model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 1 }, answers: { decision: {
          type: 'choice', choice: 'ASK', confidence: 0.8, probabilities: { ALLOW: 0.1, ASK: 0.8, BLOCK: 0.1 },
        } } };
      },
    };
    await createJevProvider(() => client, 'current').createSession().call({ stage: 'stage2', model: JEV_MODEL, system: 'Classify', messages: [], maxTokens: 2048, temperature: 0 });
    await createJevProvider(() => client, 'c').createSession().call({ stage: 'stage2', model: JEV_MODEL, system: 'Classify', messages: [], maxTokens: 2048, temperature: 0 });
    assert.equal(captured[0].includes(PROMPT_C_STAGE2_PRECEDENCE), false);
    assert.equal(captured[1].includes(PROMPT_C_STAGE2_PRECEDENCE), true);
    assert.equal(captured[1].replace(`\\n\\n${PROMPT_C_STAGE2_PRECEDENCE}`, ''), captured[0]);
  });
  test('normalises a typed Choice to the shared stage-one contract', async () => {
    const signals: AbortSignal[] = [];
    const session = createJevProvider(() => clientReturning('allow', signals)).createSession();
    assert.equal(await session.call({
      stage: 'stage1',
      model: JEV_MODEL,
      system: 'Classify',
      messages: [{ role: 'user', content: 'pwd' }],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    }), 'ALLOW');
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
    const metrics = session.snapshot();
    assert.equal(metrics.inputTokens, 17);
    assert.equal(metrics.outputTokens, 2);
    assert.equal(metrics.modelCallCount, 1);
    assert.ok(metrics.modelCallDurationMs >= 0);
    assert.deepEqual(metrics.confidences, [0.91]);
    assert.deepEqual(metrics.errors, []);
  });

  test('normalises a typed Choice to the shared stage-two JSON contract', async () => {
    const session = createJevProvider(() => clientReturning('ask')).createSession();
    const response = await session.call({
      stage: 'stage2',
      model: JEV_MODEL,
      system: 'Classify',
      messages: [{ role: 'user', content: 'rm -rf out' }],
      maxTokens: 2048,
      temperature: 0,
    });
    assert.deepEqual(JSON.parse(response), { thinking: '', decision: 'ASK' });
  });

  test('records and rejects labels outside the stage closed set', async () => {
    const session = createJevProvider(() => clientReturning('ask')).createSession();
    await assert.rejects(session.call({
      stage: 'stage1',
      model: JEV_MODEL,
      system: 'x',
      messages: [],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    }), /stage 1/);
    assert.equal(session.snapshot().errors.length, 1);
  });

  test('redacts common credential shapes', () => {
    assert.equal(redactBenchmarkError(new Error('network timeout')), 'network timeout');
    assert.doesNotMatch(redactBenchmarkError('x-api-key: sk_abcdefghijk'), /sk_abcdefghijk/);
  });
});
