import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  ClassifierConfig,
  ClassifierDecision,
  Decision,
  DecisionStage,
  ShadowDispatcher,
  ShadowJob,
} from './types.js';
import type { JevChoiceLabel, ValidatedJevChoice } from './jev-policy.js';

export const JEV_SHADOW_SCHEMA_VERSION = 1 as const;
export const JEV_SHADOW_MAX_BYTES = 10 * 1024 * 1024;
export const JEV_SHADOW_RETAINED_GENERATIONS = 5;
export const JEV_SHADOW_MAX_JOB_BYTES = 256 * 1024;
export const DEFAULT_JEV_SHADOW_LOG_PATH = resolve(homedir(), '.io-auto-mode', 'jev-shadow-log.jsonl');

export interface JevShadowScheduledEvent {
  schemaVersion: 1;
  event: 'scheduled';
  ts: string;
  correlationId: string;
  gemini: { decision: Decision; stage: DecisionStage };
}

export interface JevShadowCompletedEvent extends Omit<JevShadowScheduledEvent, 'event'> {
  event: 'completed';
  jev: {
    status: 'ok' | 'timeout' | 'provider_error' | 'dispatch_error';
    stages: Array<{ stage: 'stage1' | 'stage2' } & ValidatedJevChoice>;
    proposedDecision: Decision | null;
    latencyMs: number;
  };
  drift: 'agree' | 'jev_more_permissive' | 'jev_more_restrictive' | 'unavailable';
}

export type JevShadowEvent = JevShadowScheduledEvent | JevShadowCompletedEvent;

export interface JevShadowWorkerInput extends ShadowJob {
  logPath: string;
}

function rotateShadowLog(path: string): void {
  try {
    if (statSync(path).size < JEV_SHADOW_MAX_BYTES) return;
  } catch {
    return;
  }
  for (let index = JEV_SHADOW_RETAINED_GENERATIONS; index >= 1; index -= 1) {
    const from = index === 1 ? path : `${path}.${index - 1}`;
    const to = `${path}.${index}`;
    try { renameSync(from, to); } catch { /* absent generation or non-fatal rotation failure */ }
  }
}

/** Append only an already-normalised schema event. Never throws. */
export function appendJevShadowEvent(path: string, event: JevShadowEvent): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    rotateShadowLog(path);
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Shadow telemetry cannot influence enforcement.
  }
}

export function createScheduledEvent(job: ShadowJob, now = new Date()): JevShadowScheduledEvent {
  return {
    schemaVersion: JEV_SHADOW_SCHEMA_VERSION,
    event: 'scheduled',
    ts: now.toISOString(),
    correlationId: job.correlationId,
    gemini: { decision: job.gemini.decision, stage: job.gemini.stage },
  };
}

export function driftFor(gemini: Decision, proposed: Decision | null): JevShadowCompletedEvent['drift'] {
  if (proposed === null) return 'unavailable';
  if (gemini === proposed) return 'agree';
  const rank: Record<Decision, number> = { allow: 0, ask: 1, block: 2 };
  return rank[proposed] < rank[gemini] ? 'jev_more_permissive' : 'jev_more_restrictive';
}

export function decisionFromJevLabel(label: JevChoiceLabel): Decision {
  return label.toLowerCase() as Decision;
}

export function createCompletedEvent(options: {
  job: ShadowJob;
  status: JevShadowCompletedEvent['jev']['status'];
  stages?: JevShadowCompletedEvent['jev']['stages'];
  proposedDecision?: Decision | null;
  latencyMs: number;
  now?: Date;
}): JevShadowCompletedEvent {
  const proposedDecision = options.status === 'ok' ? options.proposedDecision ?? null : null;
  return {
    schemaVersion: JEV_SHADOW_SCHEMA_VERSION,
    event: 'completed',
    ts: (options.now ?? new Date()).toISOString(),
    correlationId: options.job.correlationId,
    gemini: {
      decision: options.job.gemini.decision,
      stage: options.job.gemini.stage,
    },
    jev: {
      status: options.status,
      stages: options.stages ?? [],
      proposedDecision,
      latencyMs: Math.max(0, Math.round(options.latencyMs)),
    },
    drift: driftFor(options.job.gemini.decision, proposedDecision),
  };
}

export function isEligibleJevShadowResult(result: ClassifierDecision): boolean {
  return (
    (result.stage === 'stage1' || result.stage === 'stage2' || result.stage === 'fallback')
    && typeof result.model === 'string'
    && result.model.startsWith('google/gemini')
  );
}

type SpawnWorker = (workerUrl: URL, environment: NodeJS.ProcessEnv) => ChildProcess;

function defaultSpawnWorker(workerUrl: URL, environment: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [fileURLToPath(workerUrl)], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: environment,
  });
  child.unref();
  return child;
}

export function createJevShadowDispatcher(options: {
  config: ClassifierConfig;
  workerUrl: URL;
  logPath?: string;
  spawnWorker?: SpawnWorker;
  environment?: NodeJS.ProcessEnv;
}): ShadowDispatcher | undefined {
  if (options.config.jevShadow.enabled !== true) return undefined;
  const logPath = options.logPath ?? DEFAULT_JEV_SHADOW_LOG_PATH;
  const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
  return {
    dispatch(job) {
      const workerInput: JevShadowWorkerInput = { ...job, logPath };
      const serialised = JSON.stringify(workerInput);
      appendJevShadowEvent(logPath, createScheduledEvent(job));
      if (Buffer.byteLength(serialised) > JEV_SHADOW_MAX_JOB_BYTES) {
        appendJevShadowEvent(logPath, createCompletedEvent({
          job,
          status: 'dispatch_error',
          latencyMs: 0,
        }));
        return;
      }
      let terminalWritten = false;
      const recordDispatchError = () => {
        if (terminalWritten) return;
        terminalWritten = true;
        appendJevShadowEvent(logPath, createCompletedEvent({
          job,
          status: 'dispatch_error',
          latencyMs: 0,
        }));
      };
      try {
        const source = options.environment ?? process.env;
        const environment: NodeJS.ProcessEnv = {};
        if (source.TYPESAFE_API_KEY) environment.TYPESAFE_API_KEY = source.TYPESAFE_API_KEY;
        const child = spawnWorker(options.workerUrl, environment);
        child.once('error', recordDispatchError);
        child.stdin?.once('error', recordDispatchError);
        if (!child.stdin) {
          recordDispatchError();
          return;
        }
        child.stdin.end(serialised);
      } catch {
        recordDispatchError();
      }
    },
  };
}
