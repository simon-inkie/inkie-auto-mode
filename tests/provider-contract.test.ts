import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createGeminiProvider } from '../benchmarks/gemini-session.js';
import { createRequestTimeout, redactProviderError } from '../benchmarks/provider-contract.js';
import { STAGE1_MAX_OUTPUT_TOKENS } from '../core/classifier.js';

describe('benchmark provider primitives', () => {
  test('timeout timer is unrefed, aborts the request, and is cleared', () => {
    let callback: (() => void) | undefined;
    let unrefCount = 0;
    let clearCount = 0;
    const handle = { unref: () => { unrefCount += 1; } };
    const timeout = createRequestTimeout(20, {
      set(fn, delayMs) {
        assert.equal(delayMs, 20);
        callback = fn;
        return handle;
      },
      clear(value) {
        assert.equal(value, handle);
        clearCount += 1;
      },
    });

    assert.equal(unrefCount, 1);
    assert.equal(timeout.signal.aborted, false);
    assert.ok(callback);
    callback();
    assert.equal(timeout.signal.aborted, true);
    assert.equal(timeout.didTimeout(), true);
    timeout.clear();
    assert.equal(clearCount, 1);
  });

  test('Gemini applies the explicit Stage 1 budget and returns visible text after thought parts', async () => {
    let observedBudget = 0;
    const provider = createGeminiProvider({
      apiKey: () => 'test-key',
      fetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          generationConfig: {
            maxOutputTokens: number;
            thinkingConfig?: { thinkingLevel: string };
          };
        };
        observedBudget = body.generationConfig.maxOutputTokens;
        assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [
            { thought: true, text: 'internal analysis' },
            { text: 'ALLOW' },
          ] } }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 },
        }), { status: 200 });
      }) as typeof fetch,
    });
    const session = provider.createSession();

    const response = await session.call({
      stage: 'stage1',
      model: provider.model,
      system: 'Classify',
      messages: [{ role: 'user', content: 'pwd' }],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });

    assert.equal(observedBudget, STAGE1_MAX_OUTPUT_TOKENS);
    assert.equal(response, 'ALLOW');
    assert.deepEqual(session.snapshot().errors, []);
  });

  test('Gemini chooses thinking semantics from explicit stage, not token budget', async () => {
    const provider = createGeminiProvider({
      apiKey: () => 'test-key',
      fetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          generationConfig: { thinkingConfig?: { thinkingLevel: string } };
        };
        assert.equal(body.generationConfig.thinkingConfig, undefined);
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"thinking":"","decision":"ALLOW"}' }] } }],
        }), { status: 200 });
      }) as typeof fetch,
    });
    await provider.createSession().call({
      stage: 'stage2',
      model: provider.model,
      system: 'Classify',
      messages: [],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
  });

  test('Gemini empty visible output is a normalised provider error', async () => {
    const provider = createGeminiProvider({
      apiKey: () => 'test-key',
      fetch: (async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ thought: true, text: 'only thought' }] } }],
      }), { status: 200 })) as typeof fetch,
    });
    const session = provider.createSession();
    await assert.rejects(session.call({
      stage: 'stage1',
      model: provider.model,
      system: 'Classify',
      messages: [],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    }), /no visible text/);
    assert.deepEqual(session.snapshot().errors, ['Gemini returned no visible text']);
  });

  test('normalises credential-bearing errors', () => {
    const normalised = redactProviderError('Authorization: Bearer secret-token?key=AIza1234567890123456');
    assert.match(normalised, /\[REDACTED\]/);
    assert.doesNotMatch(normalised, /secret-token|AIza1234567890123456/);
  });
});
