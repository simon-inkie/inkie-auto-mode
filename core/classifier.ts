import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateStatic } from './static-patterns.js';
import { buildClassifierInput } from './transcript.js';
import type {
  ClassifierDecision,
  ClassifierConfig,
  ModelCallFn,
  TranscriptEntry,
  SourceProvenance,
  Stage2Response,
  DEFAULT_CONFIG,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const systemPromptCache: Partial<Record<'shell' | 'mcp', string>> = {};

function getSystemPrompt(actionKind: 'shell' | 'mcp'): string {
  if (!systemPromptCache[actionKind]) {
    systemPromptCache[actionKind] = readFileSync(
      resolve(__dirname, '..', 'prompts', actionKind === 'mcp' ? 'mcp-system.txt' : 'system.txt'),
      'utf-8',
    );
  }
  return systemPromptCache[actionKind] as string;
}

const STAGE1_SUFFIX = '\n\nErr on the side of blocking. Respond with exactly one word: ALLOW or BLOCK';
const STAGE2_SUFFIX = '\n\nReview the classification carefully. Explicit user confirmation (not suggestive or implicit) is required to override a block. Think step by step, then respond with JSON: {"thinking": "...", "decision": "ALLOW|ASK|BLOCK", "reason": "..."}';
const FALLBACK_PREFIX = 'You are running as a fallback classifier. When uncertain, block.\n\n';

/** Allows thinking models enough budget to emit the requested visible decision. */
export const STAGE1_MAX_OUTPUT_TOKENS = 1024;
export const STAGE2_MAX_OUTPUT_TOKENS = 2048;

/**
 * Run the full classification pipeline:
 * 1. Static pattern matching (0ms)
 * 2. Stage 1 — fast LLM (ALLOW/BLOCK)
 * 3. Stage 2 — thinking LLM (ALLOW/ASK/BLOCK) — only on Stage 1 BLOCK
 *
 * Fails closed on every error path.
 */
export async function classify(
  command: string,
  transcript: TranscriptEntry[],
  modelCall: ModelCallFn,
  config: ClassifierConfig,
  options: {
    isMainSession?: boolean;
    source?: SourceProvenance;
    actionKind?: 'shell' | 'mcp';
  } = {},
): Promise<ClassifierDecision> {
  const { isMainSession = true, source = 'direct', actionKind = 'shell' } = options;
  const startTime = Date.now();

  // Mode overrides
  if (config.mode === 'yolo') {
    return { decision: 'allow', stage: 'static', durationMs: 0, reason: 'YOLO mode — all exec allowed' };
  }
  if (config.mode === 'strict') {
    if (actionKind === 'mcp') {
      return { decision: 'block', stage: 'static', durationMs: 0, reason: 'Strict mode — MCP tool is not on the explicit allowlist' };
    }
    // In strict mode, only static allows pass
    const staticResult = evaluateStatic(command);
    if (staticResult?.decision === 'block' || (staticResult?.decision === 'allow' && source !== 'external')) return staticResult;
    if (staticResult === null || source !== 'external') return { decision: 'block', stage: 'static', durationMs: 0, reason: 'Strict mode — not on explicit allowlist' };
  }

  // Layer 0: Static patterns
  if (actionKind === 'shell') {
    const staticResult = evaluateStatic(command);
    if (staticResult?.decision === 'block' || (staticResult?.decision === 'allow' && source !== 'external')) {
      return staticResult;
    }
  }

  // Build classifier input
  const userMessage = buildClassifierInput(transcript, command, source, actionKind);
  const systemPrompt = getSystemPrompt(actionKind);

  // Stage 1: Fast LLM
  const stage1Result = await runStage1(
    userMessage,
    systemPrompt,
    modelCall,
    config.stage1Model,
    config.stage1Fallback,
  );

  if (stage1Result.decision === 'allow') {
    return {
      decision: 'allow',
      stage: stage1Result.isFallback ? 'fallback' : 'stage1',
      durationMs: Date.now() - startTime,
      model: stage1Result.model,
    };
  }

  // Stage 1 returned BLOCK (or error) — escalate to Stage 2
  const stage2Result = await runStage2(
    userMessage,
    systemPrompt,
    modelCall,
    config.stage2Model,
    config.stage2Fallback,
    isMainSession,
  );

  return {
    ...stage2Result,
    durationMs: Date.now() - startTime,
  };
}

interface Stage1Result {
  decision: 'allow' | 'block';
  model: string;
  isFallback: boolean;
}

async function runStage1(
  userMessage: string,
  systemPrompt: string,
  modelCall: ModelCallFn,
  primaryModel: string,
  fallbackModel: string,
): Promise<Stage1Result> {
  // Try primary model
  try {
    const response = await modelCall({
      stage: 'stage1',
      model: primaryModel,
      system: systemPrompt + STAGE1_SUFFIX,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });

    const parsed = parseStage1Response(response);
    if (parsed !== null) {
      return { decision: parsed, model: primaryModel, isFallback: false };
    }
  } catch {
    // Primary failed — fall through to fallback
  }

  // Try fallback model
  try {
    const response = await modelCall({
      stage: 'stage1',
      model: fallbackModel,
      system: FALLBACK_PREFIX + systemPrompt + STAGE1_SUFFIX,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: STAGE1_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });

    const parsed = parseStage1Response(response);
    if (parsed !== null) {
      return { decision: parsed, model: fallbackModel, isFallback: true };
    }
  } catch {
    // Fallback also failed
  }

  // Both failed — fail closed (return block to trigger Stage 2)
  return { decision: 'block', model: 'none', isFallback: true };
}

function parseStage1Response(response: string): 'allow' | 'block' | null {
  const trimmed = response.trim().toUpperCase();
  if (trimmed === 'ALLOW') return 'allow';
  if (trimmed === 'BLOCK') return 'block';
  // Check if response starts with ALLOW or BLOCK (model may add extra text)
  if (trimmed.startsWith('ALLOW')) return 'allow';
  if (trimmed.startsWith('BLOCK')) return 'block';
  return null;
}

async function runStage2(
  userMessage: string,
  systemPrompt: string,
  modelCall: ModelCallFn,
  primaryModel: string,
  fallbackModel: string,
  isMainSession: boolean,
): Promise<ClassifierDecision> {
  // Try primary model
  try {
    const response = await modelCall({
      stage: 'stage2',
      model: primaryModel,
      system: systemPrompt + STAGE2_SUFFIX,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: STAGE2_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });

    const parsed = parseStage2Response(response);
    if (parsed !== null) {
      return finaliseStage2(parsed, primaryModel, 'stage2', isMainSession);
    }
  } catch {
    // Primary failed — fall through to fallback
  }

  // Try fallback model
  try {
    const response = await modelCall({
      stage: 'stage2',
      model: fallbackModel,
      system: FALLBACK_PREFIX + systemPrompt + STAGE2_SUFFIX,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: STAGE2_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });

    const parsed = parseStage2Response(response);
    if (parsed !== null) {
      return finaliseStage2(parsed, fallbackModel, 'fallback', isMainSession);
    }
  } catch {
    // Fallback also failed
  }

  // Both failed — ASK in main session (user is present), BLOCK in sub-agents
  return {
    decision: isMainSession ? 'ask' : 'block',
    reason: 'Classifier models unavailable (API/model routing issue). Safe to allow if you recognise this command.',
    stage: 'error',
    durationMs: 0,
  };
}

function parseStage2Response(response: string): Stage2Response | null {
  const trimmed = response.trim();

  // Try to extract JSON from the response (model may wrap in markdown code blocks)
  let jsonStr = trimmed;

  // Strip markdown code fences if present
  const jsonMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Also try finding JSON object directly
  if (!jsonStr.startsWith('{')) {
    const braceMatch = trimmed.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      jsonStr = braceMatch[0];
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const decision = String(parsed.decision ?? '').toUpperCase();
    if (decision !== 'ALLOW' && decision !== 'ASK' && decision !== 'BLOCK') {
      return null;
    }
    return {
      thinking: String(parsed.thinking ?? ''),
      decision: decision as 'ALLOW' | 'ASK' | 'BLOCK',
      reason: parsed.reason ? String(parsed.reason) : undefined,
    };
  } catch {
    return null;
  }
}

function finaliseStage2(
  parsed: Stage2Response,
  model: string,
  stage: 'stage2' | 'fallback',
  isMainSession: boolean,
): ClassifierDecision {
  let decision = parsed.decision.toLowerCase() as 'allow' | 'ask' | 'block';

  // Non-main sessions: ASK → BLOCK
  if (!isMainSession && decision === 'ask') {
    decision = 'block';
  }

  return {
    decision,
    reason: parsed.reason,
    stage,
    durationMs: 0, // caller will set this
    model,
    thinking: parsed.thinking,
  };
}

/** Reset the cached system prompt (useful for testing) */
export function resetSystemPromptCache(): void {
  delete systemPromptCache.shell;
  delete systemPromptCache.mcp;
}
