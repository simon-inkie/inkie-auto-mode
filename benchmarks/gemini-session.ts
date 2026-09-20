import {
  createRequestTimeout,
  emptyProviderMetrics,
  redactProviderError,
  type ProviderAdapter,
} from './provider-contract.js';

export const GEMINI_MODEL = 'google/gemini-3.8-flash';
export const PROVIDER_TIMEOUT_MS = 20_000;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface GeminiProviderOptions {
  apiKey?: () => string | undefined;
  fetch?: typeof fetch;
}

/** Small benchmark-only Gemini adapter. It does not change an installed route. */
export function createGeminiProvider(options: GeminiProviderOptions = {}): ProviderAdapter {
  const credential = options.apiKey ?? (() => process.env.GOOGLE_GENERATIVE_AI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY);
  const fetchImpl = options.fetch ?? fetch;

  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
    createSession() {
      const metrics = emptyProviderMetrics();
      return {
        async call({ stage, model, system, messages, maxTokens, temperature }) {
          const started = performance.now();
          metrics.modelCallCount += 1;
          const timeout = createRequestTimeout(PROVIDER_TIMEOUT_MS);
          try {
            const apiKey = credential();
            if (!apiKey) throw new Error('No Google Gemini API credential is available');
            const modelId = model.replace(/^(google|gemini)\//, '');
            const response = await fetchImpl(
              `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: timeout.signal,
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: system }] },
                  contents: messages.map((message) => ({ role: 'user', parts: [{ text: message.content }] })),
                  generationConfig: {
                    maxOutputTokens: maxTokens,
                    temperature,
                    ...(stage === 'stage1'
                      ? { thinkingConfig: { thinkingLevel: 'low' } }
                      : {}),
                  },
                }),
              },
            );
            if (!response.ok) throw new Error(`Gemini API error ${response.status}`);
            const data = await response.json() as GeminiResponse;
            metrics.inputTokens += data.usageMetadata?.promptTokenCount ?? 0;
            metrics.outputTokens += data.usageMetadata?.candidatesTokenCount ?? 0;
            const visibleText = data.candidates?.[0]?.content?.parts
              ?.filter((part) => part.thought !== true)
              .map((part) => part.text ?? '')
              .join('')
              .trim() ?? '';
            if (!visibleText) throw new Error('Gemini returned no visible text');
            return visibleText;
          } catch (error) {
            const normalised = timeout.didTimeout()
              ? `Provider request timed out after ${PROVIDER_TIMEOUT_MS}ms`
              : redactProviderError(error);
            metrics.errors.push(normalised);
            throw new Error(normalised);
          } finally {
            timeout.clear();
            metrics.modelCallDurationMs += Math.round(performance.now() - started);
          }
        },
        snapshot: () => ({ ...metrics, confidences: [...metrics.confidences], errors: [...metrics.errors] }),
      };
    },
  };
}
