import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_CONFIG } from '../core/types.js';

test('default classifier stages are pinned to Gemini 3.8 Flash', () => {
  assert.deepEqual(
    [
      DEFAULT_CONFIG.stage1Model,
      DEFAULT_CONFIG.stage1Fallback,
      DEFAULT_CONFIG.stage2Model,
      DEFAULT_CONFIG.stage2Fallback,
    ],
    Array(4).fill('google/gemini-3.8-flash'),
  );
});
