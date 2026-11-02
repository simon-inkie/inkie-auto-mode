import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { jevModelCall } from '../../../core/jev-model-call.js';
import { classify } from '../../../core/classifier.js';
import { classifyMcpCall, parseOpenClawMcpToolName } from '../../../core/mcp.js';
import { logDecision } from '../../../core/logger.js';
import { createJevShadowDispatcher } from '../../../core/jev-shadow.js';
import { serialiseTranscript } from '../../../core/transcript.js';
import type {
  ClassifierConfig,
  ConversationMessage,
  ModelCallFn,
  ModelCallOptions,
} from '../../../core/types.js';
import { mergeClassifierConfig } from '../../../core/types.js';
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
  return mergeClassifierConfig(pluginConfig);
}

type OpenClawModelApi = Pick<OpenClawPluginApi, 'config' | 'runtime'>;

/** Build the model caller separately so its HTTP contract can be unit tested. */
export function createModelCall(api: OpenClawModelApi): ModelCallFn {
  return async (options: ModelCallOptions) => {
    const [provider, ...modelParts] = options.model.split("/");
    const modelId = modelParts.join("/");

    if (provider === "typesafe") return jevModelCall(options);

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
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
}

export default definePluginEntry({
  id: 'io-auto-mode',
  name: 'Io Auto Mode',
  description: 'Hybrid static + LLM exec and MCP security classifier.',

  register(api) {
    // Set log path to absolute workspace location
    setLogPath(join(homedir(), '.openclaw', 'workspace', 'memory', 'auto-mode-log.jsonl'));

    const modelCallFn = createModelCall(api);

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

    // Intercept exec and MCP bundle tool calls. OpenClaw registers bundle MCP
    // tools as <server>__<tool>; native tools without that separator remain
    // outside this hook's classification scope.
    api.on('before_tool_call', async (event, ctx) => {
      const mcpIdentity = parseOpenClawMcpToolName(event.toolName);
      if (event.toolName !== 'exec' && !mcpIdentity) return;

      const pluginConfig = api.pluginConfig;
      const config = resolveConfig(pluginConfig);
      const shadowDispatcher = createJevShadowDispatcher({
        config,
        workerUrl: new URL('../dist/jev-shadow-worker.js', import.meta.url),
      });
      const command = event.toolName === 'exec'
        ? event.params.command as string | undefined
        : undefined;
      if (!mcpIdentity && !command) return;

      const sessionId = ctx.sessionId ?? ctx.sessionKey ?? 'default';
      const messages = sessionTranscripts.get(sessionId) ?? [];
      const transcript = serialiseTranscript(messages);

      let action: string;
      let result;
      try {
        if (mcpIdentity) {
          ({ action, result } = await classifyMcpCall({
            toolName: mcpIdentity.canonicalName,
            toolInput: event.params,
            transcript,
            modelCall: modelCallFn,
            config,
            isMainSession: true,
            source: 'direct',
            shadowDispatcher,
          }));
        } else {
          action = command as string;
          result = await classify(action, transcript, modelCallFn, config, { shadowDispatcher });
        }
      } catch (err) {
        // MCP calls fail closed: operators may rely on this plugin as the
        // approval boundary. Preserve the established exec behaviour by
        // allowing classify() to return its own error-stage decision.
        if (mcpIdentity) {
          return {
            block: true,
            blockReason: `MCP classifier unavailable: ${(err as Error).message}`,
          };
        }
        throw err;
      }
      logDecision(action, result, 'direct', { adapter: 'openclaw' });

      switch (result.decision) {
        case 'allow':
          return;
        case 'block':
          return {
            block: true,
            blockReason: mcpIdentity
              ? `${mcpIdentity.canonicalName}: ${result.reason ?? `Blocked by io-auto-mode (${result.stage})`}`
              : `\`${command}\` — ${result.reason ?? `Blocked by io-auto-mode (${result.stage})`}`,
          };
        case 'ask':
          return {
            requireApproval: {
              title: mcpIdentity ? 'MCP tool requires approval' : 'Exec requires approval',
              description: mcpIdentity
                ? `${mcpIdentity.canonicalName}\n${(result.reason ?? 'Classifier flagged this MCP call for review.').slice(0, 140)}`
                : `\`${command!.slice(0, 100)}${command!.length > 100 ? '…' : ''}\`\n${(result.reason ?? 'Classifier flagged this command for review.').slice(0, 140)}`,
              severity: 'warning' as const,
            },
          };
      }
    });
  },
});
