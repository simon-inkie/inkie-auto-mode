import { classify } from './classifier.js';
import type {
  ClassifierConfig,
  ClassifierDecision,
  ModelCallFn,
  SourceProvenance,
  TranscriptEntry,
} from './types.js';

export interface McpToolIdentity {
  canonicalName: string;
  server: string;
  tool: string;
}

export interface McpClassification {
  action: string;
  identity: McpToolIdentity;
  result: ClassifierDecision;
}

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential)/i;
const SECRET_VALUE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT = /\b(authorization|password|passwd|secret|token|api[-_]?key|private[-_]?key)=([^\s&]+)/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const MAX_ACTION_LENGTH = 8_000;

export function parseMcpToolName(toolName: string): McpToolIdentity | null {
  if (!toolName.startsWith('mcp__')) return null;
  const separator = toolName.indexOf('__', 5);
  if (separator <= 5 || separator >= toolName.length - 2) return null;
  return {
    canonicalName: toolName,
    server: toolName.slice(5, separator),
    tool: toolName.slice(separator + 2),
  };
}

/**
 * OpenClaw MCP bundle tools are registered as `<server>__<tool>`. Normalise
 * that provider-safe runtime name into the canonical name used by policy.
 * Native tools without the separator are deliberately left alone.
 */
export function parseOpenClawMcpToolName(toolName: string): McpToolIdentity | null {
  if (toolName.startsWith('mcp__')) return parseMcpToolName(toolName);
  const separator = toolName.indexOf('__');
  if (separator <= 0 || separator >= toolName.length - 2) return null;
  return parseMcpToolName(`mcp__${toolName}`);
}

function redactString(value: string): string {
  return value
    .replace(SECRET_VALUE, '$1 [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@');
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED: max depth]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1);
    }
    return result;
  }
  return value;
}

function redactToolInput(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  try {
    return JSON.stringify(redact(JSON.parse(input)));
  } catch {
    return redactString(input);
  }
}

/** Redact credential material from prior tool inputs before an MCP model call. */
export function redactMcpTranscript(transcript: TranscriptEntry[]): TranscriptEntry[] {
  return transcript.map((entry) => entry.role === 'tool'
    ? { ...entry, input: redactToolInput(entry.input) }
    : { ...entry });
}

/** Stable, redacted action string safe for model input and the audit ledger. */
export function formatMcpAction(
  identity: McpToolIdentity,
  toolInput: Record<string, unknown> | undefined,
): string {
  const serialised = JSON.stringify({
    server: identity.server,
    tool: identity.tool,
    arguments: redact(toolInput ?? {}),
  });
  if (serialised.length <= MAX_ACTION_LENGTH) return serialised;
  return JSON.stringify({
    server: identity.server,
    tool: identity.tool,
    argumentsPreview: `${serialised.slice(0, MAX_ACTION_LENGTH)}...[TRUNCATED]`,
    truncated: true,
  });
}

function matchesAny(value: string, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  });
}

/** Block takes precedence. Empty/default policy falls through to the LLM. */
export function evaluateMcpPolicy(
  identity: McpToolIdentity,
  config: ClassifierConfig,
): ClassifierDecision | null {
  if (config.mode === 'yolo') return null;
  if (matchesAny(identity.canonicalName, config.mcpBlockPatterns)) {
    return { decision: 'block', reason: 'Matched MCP block pattern', stage: 'static', durationMs: 0 };
  }
  if (matchesAny(identity.canonicalName, config.mcpAllowPatterns)) {
    return { decision: 'allow', reason: 'Matched MCP allow pattern', stage: 'static', durationMs: 0 };
  }
  return null;
}

/** Shared MCP path used by runtime adapters after normalising their wire input. */
export async function classifyMcpCall(options: {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  transcript: TranscriptEntry[];
  modelCall: ModelCallFn;
  config: ClassifierConfig;
  isMainSession?: boolean;
  source?: SourceProvenance;
  classifyFn?: typeof classify;
}): Promise<McpClassification> {
  const identity = parseMcpToolName(options.toolName);
  if (!identity) throw new Error(`Invalid canonical MCP tool name: ${options.toolName}`);
  const action = formatMcpAction(identity, options.toolInput);
  const result = evaluateMcpPolicy(identity, options.config) ?? await (
    options.classifyFn ?? classify
  )(
    action,
    redactMcpTranscript(options.transcript),
    options.modelCall,
    options.config,
    {
      isMainSession: options.isMainSession ?? true,
      source: options.source ?? 'direct',
      actionKind: 'mcp',
    },
  );
  return { action, identity, result };
}
