import { TypeSafeClient } from '@typesafe-ai/sdk';
import { JEV_MODEL, currentJevQuestion, thresholdedADecision, validateJevChoice } from './jev-policy.js';
import type { ModelCallFn } from './types.js';

export const JEV_CALL_TIMEOUT_MS = 10_000;

/** Injectable transport boundary; raw provider responses/errors never enter logs. */
export interface JevClient {
  systemOne(request: unknown, options: { signal: AbortSignal; retry: { maxRetries: number } }): Promise<{
    answers: { decision: unknown };
  }>;
}

export function createJevModelCall(
  clientProvider: () => JevClient = () => new TypeSafeClient({
    defaultModel: JEV_MODEL,
    logLevel: 'off',
    retry: { maxRetries: 0 },
  }) as unknown as JevClient,
  timeoutMs = JEV_CALL_TIMEOUT_MS,
): ModelCallFn {
  return async (options) => {
    if (options.model !== `typesafe/${JEV_MODEL}`) throw new Error('Unsupported Jev model');
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('Missing TYPESAFE_API_KEY');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Jev deadline exceeded'));
        }, timeoutMs);
      });
      const response = await Promise.race([
        clientProvider().systemOne({
          model: JEV_MODEL,
          state: JSON.stringify({ messages: options.messages, outputBudgetTokens: options.maxTokens, temperature: options.temperature }),
          questions: { decision: currentJevQuestion(options.stage, options.system) },
        }, { signal: controller.signal, retry: { maxRetries: 0 } }),
        deadline,
      ]);
      const answer = validateJevChoice(response.answers.decision);
      if (options.stage === 'stage1' && answer.choice === 'ASK') throw new Error('Invalid stage 1 label');
      const labels = options.stage === 'stage1' ? ['ALLOW', 'BLOCK'] : ['ALLOW', 'ASK', 'BLOCK'];
      const raw = (response.answers.decision as { probabilities: Record<string, unknown> }).probabilities;
      if (labels.some(label => typeof raw[label] !== 'number')
        || Math.abs(labels.reduce((sum, label) => sum + answer.probabilities[label as keyof typeof answer.probabilities], 0) - 1) > 0.001) {
        throw new Error('Incomplete Jev probabilities');
      }
      const decision = thresholdedADecision(options.stage, answer.probabilities);
      return options.stage === 'stage1' ? decision : JSON.stringify({ thinking: '', decision });
    } catch {
      // SDK errors may contain request bodies, headers or credential values.
      throw new Error(controller.signal.aborted ? 'Jev classifier timed out' : 'Jev classifier request failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export const jevModelCall = createJevModelCall();
