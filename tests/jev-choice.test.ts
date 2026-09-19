import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  JEV_MODEL,
  createJevChoiceAdapter,
  normaliseJevChoice,
  redactBenchmarkError,
  type JevSystemOneClient,
} from '../benchmarks/jev-choice.js';
import type { BenchmarkFixture } from '../core/types.js';

const fixture: BenchmarkFixture = {
  id: 'choice-allow',
  category: 'benchmark-adapter',
  command: 'rm preview.webp',
  expected: 'allow',
  transcript: [{ role: 'user', text: 'Check the branch.' }],
};

function clientReturning(choice: string): JevSystemOneClient {
  return {
    async systemOne(request) {
      assert.equal(request.model, JEV_MODEL);
      assert.deepEqual(JSON.parse(request.state), {
        command: 'rm preview.webp',
        transcript: fixture.transcript,
        source: 'direct',
      });
      return {
        model: JEV_MODEL,
        usage: { input_tokens: 17, output_tokens: 2 },
        answers: { decision: { choice, confidence: 0.91 } },
      };
    },
  };
}

describe('Jev Choice benchmark adapter', () => {
  test('maps a typed Choice result and preserves usage and confidence', async () => {
    const result = await createJevChoiceAdapter(clientReturning('ALLOW'))(fixture);
    assert.deepEqual(result, {
      decision: 'allow',
      stage: 'stage1',
      confidence: 0.91,
      usage: { inputTokens: 17, outputTokens: 2 },
      model: JEV_MODEL,
    });
  });

  test('normalises only the closed decision set', () => {
    assert.equal(normaliseJevChoice(' ask '), 'ask');
    assert.throws(() => normaliseJevChoice('approve'), /Unexpected Jev Choice label/);
    assert.throws(() => normaliseJevChoice(null), /Unexpected Jev Choice label/);
  });

  test('fails closed and redacts a provider error', async () => {
    const result = await createJevChoiceAdapter({
      async systemOne() {
        throw new Error('Authorization: Bearer ts_abcdefghijk TYPESAFE_API_KEY=ts_secretvalue');
      },
    })(fixture);
    assert.equal(result.decision, 'block');
    assert.equal(result.stage, 'error');
    assert.match(result.error ?? '', /\[REDACTED\]/);
    assert.doesNotMatch(result.error ?? '', /ts_abcdefghijk|ts_secretvalue/);
  });

  test('redacts common credential shapes without changing ordinary errors', () => {
    assert.equal(redactBenchmarkError(new Error('network timeout')), 'network timeout');
    assert.doesNotMatch(
      redactBenchmarkError('x-api-key: sk_abcdefghijk'),
      /sk_abcdefghijk/,
    );
  });
});
