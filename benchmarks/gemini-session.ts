import {
  createRequestTimeout,
  emptyProviderMetrics,
  redactProviderError,
  runWithProviderDeadline,
  type ProviderAdapter,
} from './provider-contract.js';

export const GEMINI_MODEL = 'google/gemini-3.8-flash';
export const GEMINI_FLASH_LITE_MODEL = 'google/gemini-3.5-flash-lite';
export const PROVIDER_TIMEOUT_MS = 30_000;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiProviderOptions {
  model?: string;
  apiKey?: () => string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Small benchmark-only Gemini adapter. It does not change an installed route. */
export function createGeminiProvider(
  modelOrOptions: string | GeminiProviderOptions = {},
): ProviderAdapter {
  const options = typeof modelOrOptions === 'string' ? { model: modelOrOptions } : modelOrOptions;
  const credential = options.apiKey ?? (() => process.env.GOOGLE_GENERATIVE_AI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;

  return {
    provider: 'gemini',
    model: options.model ?? GEMINI_MODEL,
    createSession() {
      const metrics = emptyProviderMetrics();
      return {
        async call({ stage, model, system, messages, maxTokens, temperature }) {
          const started = performance.now();
          metrics.modelCallCount += 1;
          const timeout = createRequestTimeout(timeoutMs);
          try {
            const apiKey = credential();
            if (!apiKey) throw new Error('No Google Gemini API credential is available');
            const modelId = model.replace(/^(google|gemini)\//, '');
            const data = await runWithProviderDeadline(
              async signal => {
                const response = await fetchImpl(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                  },
                  signal,
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
                return response.json() as Promise<GeminiResponse>;
              },
              timeout,
            );
            metrics.inputTokens += data.usageMetadata?.promptTokenCount ?? 0;
            metrics.outputTokens += data.usageMetadata?.candidatesTokenCount ?? 0;
            metrics.thoughtsTokenCount = (metrics.thoughtsTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0);
            metrics.cachedContentTokenCount = (metrics.cachedContentTokenCount ?? 0) + (data.usageMetadata?.cachedContentTokenCount ?? 0);
            metrics.toolUsePromptTokenCount = (metrics.toolUsePromptTokenCount ?? 0) + (data.usageMetadata?.toolUsePromptTokenCount ?? 0);
            metrics.totalTokenCount = (metrics.totalTokenCount ?? 0) + (data.usageMetadata?.totalTokenCount ?? 0);
            const visibleText = data.candidates?.[0]?.content?.parts
              ?.filter((part) => part.thought !== true)
              .map((part) => part.text ?? '')
              .join('')
              .trim() ?? '';
            if (!visibleText) throw new Error('Gemini returned no visible text');
            return visibleText;
          } catch (error) {
            const normalised = timeout.didTimeout()
              ? `Provider request timed out after ${timeoutMs}ms`
              : redactProviderError(error);
            metrics.errors.push(normalised);
            throw new Error(normalised);
          } finally {
            timeout.clear();
            metrics.modelCallDurationMs += Math.round(performance.now() - started);
          }
        },
        snapshot: () => ({ ...metrics, confidences: [...metrics.confidences], errors: [...metrics.errors], answers: [...metrics.answers] }),
      };
    },
  };
}
