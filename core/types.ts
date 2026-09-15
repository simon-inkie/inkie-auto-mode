/** Source provenance — where the content originated */
export type SourceProvenance = 'direct' | 'external' | 'agent';

/** Which stage made the decision */
export type DecisionStage = 'static' | 'stage1' | 'stage2' | 'fallback' | 'error';

/** Three-tier outcome */
export type Decision = 'allow' | 'ask' | 'block';

/** Classifier result returned from the pipeline */
export interface ClassifierDecision {
  decision: Decision;
  reason?: string;
  stage: DecisionStage;
  durationMs: number;
  model?: string;
  thinking?: string;
}

/** A single transcript entry for the classifier */
export interface TranscriptEntry {
  role: 'user' | 'tool';
  source?: SourceProvenance;
  text?: string;
  name?: string;
  input?: string;
}

/** Stage 2 JSON response from the LLM */
export interface Stage2Response {
  thinking: string;
  decision: 'ALLOW' | 'ASK' | 'BLOCK';
  reason?: string;
}

/** Model configuration for the classifier */
export interface ClassifierConfig {
  stage1Model: string;
  stage1Fallback: string;
  stage2Model: string;
  stage2Fallback: string;
  mode: 'classify' | 'yolo' | 'strict';
  nonMainMode: 'block' | 'classify';
  userAllowPatterns: string[];
  userBlockPatterns: string[];
  /** Regexes matched against canonical MCP names, e.g. mcp__github__get_issue. */
  mcpAllowPatterns: string[];
  mcpBlockPatterns: string[];
}

/** Default configuration */
export const DEFAULT_CONFIG: ClassifierConfig = {
  stage1Model: 'google/gemini-3.1-flash-lite',
  stage1Fallback: 'google/gemini-3.1-flash-lite',
  stage2Model: 'google/gemini-3.1-flash-lite',
  stage2Fallback: 'google/gemini-3.1-flash-lite',
  mode: 'classify',
  nonMainMode: 'block',
  userAllowPatterns: [],
  userBlockPatterns: [],
  mcpAllowPatterns: [],
  mcpBlockPatterns: [],
};

/** Provider-agnostic model call interface */
export interface ModelCallOptions {
  model: string;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  maxTokens: number;
  temperature: number;
}

/** Provider-agnostic model call function signature */
export type ModelCallFn = (options: ModelCallOptions) => Promise<string>;

/** Conversation message from OpenClaw (input to transcript serialiser) */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | AssistantContentBlock[];
  source?: SourceProvenance;
  tool_use?: { name: string; input: string };
  name?: string;          // tool name for tool role
  tool_input?: string;    // tool input for tool role
}

export interface AssistantContentBlock {
  type: 'text' | 'tool_use';
  name?: string;
  input?: unknown;
  text?: string;
}

/** Benchmark fixture format */
export interface BenchmarkFixture {
  id: string;
  command: string;
  transcript: TranscriptEntry[];
  expected: Decision;
  category: string;
}

/** Benchmark result for a single fixture */
export interface BenchmarkResult {
  id: string;
  category: string;
  command: string;
  expected: Decision;
  actual: Decision;
  pass: boolean;
  stage: DecisionStage;
  durationMs: number;
  model?: string;
  reason?: string;
  thinking?: string;
}

/** Log entry written to JSONL */
export interface LogEntry {
  ts: string;
  command: string;
  stage: DecisionStage;
  decision: Decision;
  durationMs: number;
  model?: string;
  reason?: string;
  thinking?: string;
  source?: SourceProvenance;
  // Adapter identity — populated by adapters when logging so audits can
  // distinguish entries from different runtimes. All fields optional.
  adapter?: string;
  conversationId?: string;
  cursorVersion?: string;
  workspaceRoots?: string[];
  userEmail?: string | null;
}

/** Optional adapter identity fields passed to logDecision. */
export interface LogIdentity {
  adapter?: string;
  conversationId?: string;
  cursorVersion?: string;
  workspaceRoots?: string[];
  userEmail?: string | null;
}
