import type { ModelCallFn, ModelCallOptions } from '../core/types.js';

export type ProviderName = 'gemini' | 'jev';

export interface ProviderMetrics {
  inputTokens: number;
  outputTokens: number;
  modelCallDurationMs: number;
  modelCallCount: number;
  confidences: number[];
  errors: string[];
  answers: Array<{ choice: string; probabilities: Record<string, number>; confidence: number; stage: string }>;
}

export interface ProviderSession {
  call(options: ModelCallOptions): ReturnType<ModelCallFn>;
  snapshot(): ProviderMetrics;
}

export interface ProviderAdapter {
  provider: ProviderName;
  model: string;
  variant?: string;
  createSession(): ProviderSession;
}

export function emptyProviderMetrics(): ProviderMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    modelCallDurationMs: 0,
    modelCallCount: 0,
    confidences: [],
    errors: [],
    answers: [],
  };
}

/** Redact common credential shapes before an error enters a benchmark artefact. */
export function redactProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, '$1[REDACTED]')
    .replace(/((?:x-)?api[-_]?key\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/((?:typesafe_api_key|token|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ts_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

interface TimeoutHandle {
  unref(): void;
}

interface TimeoutFunctions {
  set(callback: () => void, delayMs: number): TimeoutHandle;
  clear(handle: TimeoutHandle): void;
}

const nativeTimeoutFunctions: TimeoutFunctions = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One abort signal per provider request, with a clearable hard-deadline timer. */
export function createRequestTimeout(
  durationMs: number,
  timers: TimeoutFunctions = nativeTimeoutFunctions,
): { signal: AbortSignal; clear(): void; didTimeout(): boolean; deadline: Promise<never> } {
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  deadline.catch(() => undefined);
  const timer = timers.set(() => {
    timedOut = true;
    const error = new Error(`Provider request timed out after ${durationMs}ms`);
    controller.abort(error);
    rejectDeadline(error);
  }, durationMs);
  return {
    signal: controller.signal,
    clear: () => timers.clear(timer),
    didTimeout: () => timedOut,
    deadline,
  };
}

/** Enforce a hard deadline even when a provider ignores abort or hangs parsing its response. */
export async function runWithProviderDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeout: ReturnType<typeof createRequestTimeout>,
): Promise<T> {
  const operationResult = Promise.resolve().then(() => operation(timeout.signal));
  try {
    return await Promise.race([operationResult, timeout.deadline]);
  } finally {
    timeout.clear();
  }
}
