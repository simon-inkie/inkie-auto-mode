import type { ConversationMessage, TranscriptEntry, SourceProvenance } from './types.js';

/**
 * Serialise a conversation into the compact JSONL format for the classifier.
 *
 * Rules:
 * - Include user turns (with source provenance)
 * - Include tool_use blocks from assistant turns (but strip assistant text)
 * - Exclude tool results (avoids data exfil via classifier, keeps context small)
 * - Tag each entry with source provenance
 */
export function serialiseTranscript(messages: ConversationMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const source = inferProvenance(msg);
      if (typeof msg.content === 'string' && msg.content.trim()) {
        entries.push({ role: 'user', source, text: msg.content });
      }
    } else if (msg.role === 'assistant') {
      // Only extract tool_use blocks, strip all text
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.name) {
            entries.push({
              role: 'tool',
              name: block.name,
              input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
            });
          }
        }
      }
    } else if (msg.role === 'tool' && msg.name) {
      // Tool role entries from structured conversation formats
      entries.push({
        role: 'tool',
        name: msg.name,
        input: msg.tool_input ?? msg.content as string ?? '',
      });
    }
  }

  return entries;
}

/**
 * Infer source provenance for a message.
 * - direct: user typed it
 * - external: ingested from web, PDF, email
 * - agent: model acting autonomously
 */
function inferProvenance(msg: ConversationMessage): SourceProvenance {
  if (msg.source) return msg.source;
  // Default to 'direct' — in production, OpenClaw would tag this
  return 'direct';
}

/**
 * Convert transcript entries to compact JSONL string for the classifier input.
 */
export function transcriptToJsonl(entries: TranscriptEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

/**
 * Build the full classifier user message from transcript + action being evaluated.
 */
export function buildClassifierInput(
  transcript: TranscriptEntry[],
  command: string,
  source: SourceProvenance = 'direct',
  actionKind: 'shell' | 'mcp' = 'shell',
): string {
  const lines: string[] = [];

  if (transcript.length > 0) {
    lines.push('## Conversation Transcript');
    lines.push(transcriptToJsonl(transcript));
    lines.push('');
  }

  lines.push('## Action to Classify');
  lines.push(JSON.stringify(
    actionKind === 'mcp'
      ? { kind: 'mcp', action: command, source }
      : { kind: 'shell', command, source },
  ));

  return lines.join('\n');
}
