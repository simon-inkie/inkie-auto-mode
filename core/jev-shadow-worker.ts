import { TypeSafeClient } from '@typesafe-ai/sdk';
import { performance } from 'node:perf_hooks';
import { classifierSystemPromptForStage } from './classifier.js';
import {
  JEV_MODEL,
  currentJevQuestion,
  thresholdedADecision,
  validateJevChoice,
  type ValidatedJevChoice,
} from './jev-policy.js';
import {
  appendJevShadowEvent,
  createCompletedEvent,
  decisionFromJevLabel,
  type JevShadowWorkerInput,
} from './jev-shadow.js';

export const JEV_SHADOW_TIMEOUT_MS = 30_000;

export interface JevShadowClient {
  systemOne(request: unknown, options?: { signal?: AbortSignal; retry?: { maxRetries: number } }): Promise<{
    answers: { decision: unknown };
  }>;
}

async function readStdin(maxBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('Shadow job too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function executeJevShadow(
  job: JevShadowWorkerInput,
  client: JevShadowClient,
  timeoutMs = JEV_SHADOW_TIMEOUT_MS,
): Promise<void> {
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  deadline.catch(() => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new Error('Jev shadow timeout');
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  timer.unref();
  const stages: Array<{ stage: 'stage1' | 'stage2' } & ValidatedJevChoice> = [];
  try {
    const call = async (stage: 'stage1' | 'stage2'): Promise<ValidatedJevChoice> => {
      const response = await Promise.race([
        client.systemOne({
          state: JSON.stringify({ messages: [{ role: 'user', content: job.userMessage }] }),
          questions: { decision: currentJevQuestion(stage, classifierSystemPromptForStage(stage, job.systemPrompt)) },
          model: JEV_MODEL,
        }, { signal: controller.signal, retry: { maxRetries: 0 } }),
        deadline,
      ]);
      const answer = validateJevChoice(response.answers.decision);
      stages.push({ stage, ...answer });
      return answer;
    };
    const stage1 = await call('stage1');
    let selected = thresholdedADecision('stage1', stage1.probabilities);
    if (selected !== 'ALLOW') {
      const stage2 = await call('stage2');
      selected = thresholdedADecision('stage2', stage2.probabilities);
    }
    appendJevShadowEvent(job.logPath, createCompletedEvent({
      job,
      status: 'ok',
      stages,
      proposedDecision: decisionFromJevLabel(selected),
      latencyMs: performance.now() - started,
    }));
  } catch {
    appendJevShadowEvent(job.logPath, createCompletedEvent({
      job,
      status: timedOut ? 'timeout' : 'provider_error',
      stages,
      latencyMs: performance.now() - started,
    }));
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let job: JevShadowWorkerInput | undefined;
  try {
    job = JSON.parse(await readStdin()) as JevShadowWorkerInput;
    const client = new TypeSafeClient({
      defaultModel: JEV_MODEL,
      logLevel: 'warn',
      retry: { maxRetries: 0 },
    });
    await executeJevShadow(job, client as unknown as JevShadowClient);
  } catch {
    if (job?.correlationId && job.logPath) {
      appendJevShadowEvent(job.logPath, createCompletedEvent({
        job,
        status: 'provider_error',
        latencyMs: 0,
      }));
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
