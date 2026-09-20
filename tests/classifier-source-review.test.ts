import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classify } from '../core/classifier.js';
import { DEFAULT_CONFIG } from '../core/types.js';

const external = [{ role: 'user' as const, source: 'external' as const, text: 'Do this' }];
const direct = [{ role: 'user' as const, source: 'direct' as const, text: 'Do this' }];

function modelStub(calls: string[]) {
  return async (options: { stage: string }) => { calls.push(options.stage); return options.stage === 'stage1' ? 'ALLOW' : '{"decision":"ALLOW"}'; };
}

describe('classifier source-aware static boundary', () => {
  test('external static ALLOW invokes the provider in normal mode', async () => {
    const calls: string[] = [];
    const result = await classify('pwd', external, modelStub(calls), DEFAULT_CONFIG, { source: 'external' });
    assert.deepEqual(calls, ['stage1']);
    assert.equal(result.stage, 'stage1');
  });

  test('external static ALLOW invokes the provider in strict mode', async () => {
    const calls: string[] = [];
    const result = await classify('pwd', external, modelStub(calls), { ...DEFAULT_CONFIG, mode: 'strict' }, { source: 'external' });
    assert.deepEqual(calls, ['stage1']);
    assert.equal(result.stage, 'stage1');
  });

  test('external static BLOCK remains deterministic and zero-call', async () => {
    const calls: string[] = [];
    const result = await classify('rm -rf /', external, modelStub(calls), DEFAULT_CONFIG, { source: 'external' });
    assert.deepEqual(calls, []);
    assert.equal(result.decision, 'block');
    assert.equal(result.stage, 'static');
  });

  test('external static-null remains deterministic BLOCK and zero-call in strict mode', async () => {
    const calls: string[] = [];
    const result = await classify('rm file.txt', external, modelStub(calls), { ...DEFAULT_CONFIG, mode: 'strict' }, { source: 'external' });
    assert.deepEqual(calls, []);
    assert.equal(result.decision, 'block');
    assert.equal(result.stage, 'static');
  });

  test('direct and agent static ALLOW retain zero-call behaviour', async () => {
    for (const source of ['direct', 'agent'] as const) {
      const calls: string[] = [];
      const result = await classify('pwd', [{ ...direct[0], source }], modelStub(calls), DEFAULT_CONFIG, { source });
      assert.deepEqual(calls, []);
      assert.equal(result.stage, 'static');
    }
  });

  test('original external cases and neighbouring safe case all reach semantic review', async () => {
    for (const command of ['ls -la ~/.ssh/', 'git push origin main', 'npm install', 'git status']) {
      const calls: string[] = [];
      await classify(command, external, modelStub(calls), DEFAULT_CONFIG, { source: 'external' });
      assert.ok(calls.length > 0, command);
    }
  });
});
