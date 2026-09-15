import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { classify } from '../../../core/classifier.js';
import { logDecision } from '../../../core/logger.js';
import { serialiseTranscript } from '../../../core/transcript.js';
import type {
  ClassifierConfig,
  ConversationMessage,
  ModelCallFn,
  ModelCallOptions,
} from '../../../core/types.js';
import { DEFAULT_CONFIG } from '../../../core/types.js';
import { setLogPath } from '../../../core/logger.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Rolling transcript cache keyed by sessionId, max 20 messages per session. */
const sessionTranscripts = new Map<string, ConversationMessage[]>();

const MAX_TRANSCRIPT_SIZE = 20;

function pushMessage(sessionId: string, msg: ConversationMessage): void {
  let transcript = sessionTranscripts.get(sessionId);
  if (!transcript) {
    transcript = [];
    sessionTranscripts.set(sessionId, transcript);
  }
  transcript.push(msg);
  if (transcript.length > MAX_TRANSCRIPT_SIZE) {
    transcript.splice(0, transcript.length - MAX_TRANSCRIPT_SIZE);
  }
}

function resolveConfig(pluginConfig?: Record<string, unknown>): ClassifierConfig {
  const cfg = pluginConfig ?? {};
  return {
    stage1Model: (cfg.stage1Model as string) ?? DEFAULT_CONFIG.stage1Model,
    stage1Fallback: (cfg.stage1Fallback as string) ?? DEFAULT_CONFIG.stage1Fallback,
    stage2Model: (cfg.stage2Model as string) ?? DEFAULT_CONFIG.stage2Model,
    stage2Fallback: (cfg.stage2Fallback as string) ?? DEFAULT_CONFIG.stage2Fallback,
    mode: (cfg.mode as ClassifierConfig['mode']) ?? DEFAULT_CONFIG.mode,
    nonMainMode: DEFAULT_CONFIG.nonMainMode,
    userAllowPatterns: (cfg.userAllowPatterns as string[]) ?? DEFAULT_CONFIG.userAllowPatterns,
    userBlockPatterns: (cfg.userBlockPatterns as string[]) ?? DEFAULT_CONFIG.userBlockPatterns,
    mcpAllowPatterns: (cfg.mcpAllowPatterns as string[]) ?? DEFAULT_CONFIG.mcpAllowPatterns,
    mcpBlockPatterns: (cfg.mcpBlockPatterns as string[]) ?? DEFAULT_CONFIG.mcpBlockPatterns,
  };
}

export default definePluginEntry({
  id: 'io-auto-mode',
  name: 'Io Auto Mode',
  description: 'Hybrid static + LLM exec security classifier.',

  register(api) {
    // Set log path to absolute workspace location
    setLogPath(join(homedir(), '.openclaw', 'workspace', 'memory', 'auto-mode-log.jsonl'));

    const modelCallFn: ModelCallFn = async (options: ModelCallOptions) => {
      const [provider, ...modelParts] = options.model.split("/");
      const modelId = modelParts.join("/");

      // Get API key via OpenClaw runtime auth
      let apiKey: string | undefined;
      try {
        const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
          provider,
          cfg: api.config,
        });
        apiKey = (auth as { apiKey?: string })?.apiKey;
      } catch { /* fall through */ }

      // Fallback to env vars. GOOGLE_GENERATIVE_AI_API_KEY is the canonical
      // supported name; GEMINI_API_KEY / GOOGLE_API_KEY (the names Google's
      // own SDKs auto-discover) are back-compat fallbacks.
      // `||`, not `??`: these vars are routinely set-but-empty in agent
      // environments, and `??` only falls through on null/undefined, so an
      // empty canonical value would mask a populated fallback below it.
      if (!apiKey && provider === "google")
        apiKey =
          process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
          process.env.GEMINI_API_KEY ||
          process.env.GOOGLE_API_KEY;
      if (!apiKey && provider === "anthropic") apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error(`No API key for provider: ${provider}`);

      try {
        if (provider === "google") {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: options.system }] },
              contents: options.messages.map((m) => ({
                role: "user" as const,
                parts: [{ text: m.content }],
              })),
              generationConfig: { maxOutputTokens: options.maxTokens, temperature: options.temperature },
            }),
          },
        );
        if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
        const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      }

      if (provider === "anthropic") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: modelId,
            max_tokens: options.maxTokens,
            system: options.system,
            messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
        const data = await res.json() as { content?: Array<{ text?: string }> };
        return data.content?.[0]?.text ?? "";
      }

        throw new Error(`Unsupported provider: ${provider}`);
      } catch (err) {
        logDecision(options.model, { decision: 'block', stage: 'error', durationMs: 0, reason: `API call threw: ${err}` });
        throw err;
      }
    };

    // Cache user messages for transcript context
    api.on('message_received', (event, _ctx) => {
      const sessionId = _ctx.conversationId ?? _ctx.channelId ?? 'default';
      pushMessage(sessionId, {
        role: 'user',
        content: event.content,
        source: 'direct',
      });
    });

    // Clean up transcript cache on session end
    api.on('session_end', (event, ctx) => {
      sessionTranscripts.delete(event.sessionId ?? ctx.sessionKey ?? '');
    });

    // Intercept exec tool calls
    api.on('before_tool_call', async (event, ctx) => {
      if (event.toolName !== 'exec') return;

      const pluginConfig = api.pluginConfig;
      const config = resolveConfig(pluginConfig);
      const command = event.params.command as string;
      if (!command) return;

      const sessionId = ctx.sessionId ?? ctx.sessionKey ?? 'default';
      const messages = sessionTranscripts.get(sessionId) ?? [];
      const transcript = serialiseTranscript(messages);

      const result = await classify(command, transcript, modelCallFn, config);
      logDecision(command, result, 'direct');

      switch (result.decision) {
        case 'allow':
          return;
        case 'block':
          return {
            block: true,
            blockReason: `\`${command}\` — ${result.reason ?? `Blocked by io-auto-mode (${result.stage})`}`,
          };
        case 'ask':
          return {
            requireApproval: {
              title: 'Exec requires approval',
              description: `\`${command.slice(0, 100)}${command.length > 100 ? '…' : ''}\`\n${(result.reason ?? 'Classifier flagged this command for review.').slice(0, 140)}`,
              severity: 'warning' as const,
            },
          };
      }
    });
  },
});
