#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

type CountMap = Record<string, number>;

export interface JevShadowSummary {
  eligible: number;
  scheduled: number;
  completed: number;
  orphanScheduled: number;
  orphanCompleted: number;
  malformedLines: number;
  agreement: CountMap;
  jevStatus: CountMap;
  jevErrorRate: number;
  geminiStageMix: CountMap;
  jevStageMix: CountMap;
  latencyMs: { p50: number | null; p95: number | null };
}

const DECISIONS = new Set(['allow', 'ask', 'block']);
const GEMINI_STAGES = new Set(['stage1', 'stage2', 'fallback']);
const STATUSES = new Set(['ok', 'timeout', 'provider_error', 'dispatch_error']);
const DRIFTS = new Set(['agree', 'jev_more_permissive', 'jev_more_restrictive', 'unavailable']);

function increment(target: CountMap, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Parse only the versioned allowlist; every other field is ignored. */
export function summariseJevShadowJsonl(text: string): JevShadowSummary {
  const scheduledIds = new Set<string>();
  const completedIds = new Set<string>();
  const eligibleIds = new Set<string>();
  const agreement: CountMap = {};
  const jevStatus: CountMap = {};
  const geminiStageMix: CountMap = {};
  const jevStageMix: CountMap = {};
  const latencies: number[] = [];
  let scheduled = 0;
  let completed = 0;
  let malformedLines = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw.schemaVersion !== 1 || typeof raw.correlationId !== 'string') throw new Error('invalid envelope');
      const gemini = raw.gemini as Record<string, unknown> | undefined;
      if (!gemini || !DECISIONS.has(String(gemini.decision)) || !GEMINI_STAGES.has(String(gemini.stage))) {
        throw new Error('invalid Gemini summary');
      }
      eligibleIds.add(raw.correlationId);
      if (raw.event === 'scheduled') {
        scheduled += 1;
        scheduledIds.add(raw.correlationId);
        continue;
      }
      if (raw.event !== 'completed') throw new Error('invalid event');
      const jev = raw.jev as Record<string, unknown> | undefined;
      if (!jev || !STATUSES.has(String(jev.status)) || !DRIFTS.has(String(raw.drift))) throw new Error('invalid terminal');
      const latency = Number(jev.latencyMs);
      if (!Number.isFinite(latency) || latency < 0) throw new Error('invalid latency');
      const stages = Array.isArray(jev.stages) ? jev.stages : [];
      for (const stage of stages) {
        if (!stage || typeof stage !== 'object') continue;
        const name = String((stage as Record<string, unknown>).stage);
        if (name === 'stage1' || name === 'stage2') increment(jevStageMix, name);
      }
      completed += 1;
      completedIds.add(raw.correlationId);
      increment(agreement, String(raw.drift));
      increment(jevStatus, String(jev.status));
      increment(geminiStageMix, String(gemini.stage));
      latencies.push(latency);
    } catch {
      malformedLines += 1;
    }
  }

  const errorCount = (jevStatus.timeout ?? 0) + (jevStatus.provider_error ?? 0) + (jevStatus.dispatch_error ?? 0);
  return {
    eligible: eligibleIds.size,
    scheduled,
    completed,
    orphanScheduled: [...scheduledIds].filter((id) => !completedIds.has(id)).length,
    orphanCompleted: [...completedIds].filter((id) => !scheduledIds.has(id)).length,
    malformedLines,
    agreement,
    jevStatus,
    jevErrorRate: completed === 0 ? 0 : errorCount / completed,
    geminiStageMix,
    jevStageMix,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}

function main(): void {
  const path = process.argv[2] ?? resolve(homedir(), '.io-auto-mode', 'jev-shadow-log.jsonl');
  const text = readFileSync(path, 'utf8');
  process.stdout.write(`${JSON.stringify(summariseJevShadowJsonl(text), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
