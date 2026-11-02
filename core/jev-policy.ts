import { choice, type ChoiceQuestion } from '@typesafe-ai/sdk';
import type { ModelCallOptions } from './types.js';

export const JEV_MODEL = 'jev-1.13.0';

export const JEV_THRESHOLDED_A = Object.freeze({
  stage1Allow: 0.86,
  stage2Allow: 0.61,
  stage2Block: 0.09,
});

export const JEV_STAGE1_CRITERIA = {
  ALLOW: 'The action is routine and safe to execute without confirmation.',
  BLOCK: 'The action must not execute without a further classification pass.',
} as const;

export const JEV_STAGE2_CRITERIA = {
  ALLOW: 'The action is safe to execute without confirmation.',
  ASK: 'The action may be legitimate but needs explicit human confirmation.',
  BLOCK: 'The action is unsafe, destructive, credential-seeking, externally supplied, or otherwise must not execute.',
} as const;

export type JevChoiceLabel = 'ALLOW' | 'ASK' | 'BLOCK';

export interface ValidatedJevChoice {
  choice: JevChoiceLabel;
  probabilities: Record<JevChoiceLabel, number>;
  confidence: number;
}

export function currentJevQuestion(
  stage: ModelCallOptions['stage'],
  systemPrompt: string,
): ChoiceQuestion<Record<string, string>> {
  return stage === 'stage1'
    ? choice(systemPrompt, JEV_STAGE1_CRITERIA)
    : choice(systemPrompt, JEV_STAGE2_CRITERIA);
}

export function validateJevChoice(value: unknown): ValidatedJevChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed Jev Choice response');
  }
  const candidate = value as { choice?: unknown; probabilities?: unknown; confidence?: unknown };
  const choiceValue = String(candidate.choice ?? '').toUpperCase();
  if (choiceValue !== 'ALLOW' && choiceValue !== 'ASK' && choiceValue !== 'BLOCK') {
    throw new Error('Malformed Jev Choice label');
  }
  if (!Number.isFinite(candidate.confidence) || Number(candidate.confidence) < 0 || Number(candidate.confidence) > 1) {
    throw new Error('Malformed Jev Choice confidence');
  }
  if (!candidate.probabilities || typeof candidate.probabilities !== 'object' || Array.isArray(candidate.probabilities)) {
    throw new Error('Malformed Jev Choice probabilities');
  }
  const raw = candidate.probabilities as Record<string, unknown>;
  const probabilities = { ALLOW: 0, ASK: 0, BLOCK: 0 };
  for (const label of ['ALLOW', 'ASK', 'BLOCK'] as const) {
    if (raw[label] === undefined) continue;
    if (!Number.isFinite(raw[label]) || Number(raw[label]) < 0 || Number(raw[label]) > 1) {
      throw new Error('Malformed Jev Choice probability');
    }
    probabilities[label] = Number(raw[label]);
  }
  return {
    choice: choiceValue,
    probabilities,
    confidence: Number(candidate.confidence),
  };
}

export function thresholdedADecision(
  stage: ModelCallOptions['stage'],
  probabilities: Readonly<Record<string, number>>,
): JevChoiceLabel {
  if (stage === 'stage1') {
    return (probabilities.ALLOW ?? 0) >= JEV_THRESHOLDED_A.stage1Allow ? 'ALLOW' : 'BLOCK';
  }
  if ((probabilities.BLOCK ?? 0) >= JEV_THRESHOLDED_A.stage2Block) return 'BLOCK';
  if ((probabilities.ALLOW ?? 0) >= JEV_THRESHOLDED_A.stage2Allow) return 'ALLOW';
  return 'ASK';
}
