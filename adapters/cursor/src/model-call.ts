/**
 * Model-call adapter for the Cursor hook. Duplicated from the Claude Code
 * adapter — see BACKLOG entry "DRY up model-call across adapters" for the
 * planned move into core/.
 *
 * Talks to Gemini or Anthropic over plain fetch — no SDK dependency. Provider
 * is encoded in the model string as `<provider>/<model-id>`, matching the
 * OpenClaw and Claude Code adapters.
 *
 * Keys are read from process.env. Typical layout (set in
 * ~/.io-auto-mode/.env, loaded by hook.ts before any classifier code runs):
 *   GOOGLE_GENERATIVE_AI_API_KEY=...
 *   ANTHROPIC_API_KEY=...
 *
 * GOOGLE_GENERATIVE_AI_API_KEY is the canonical supported name. GEMINI_API_KEY
 * and GOOGLE_API_KEY (the names Google's own SDKs auto-discover) are kept as
 * back-compat fallbacks, tried in that order.
 */

import type { ModelCallFn, ModelCallOptions } from "../../../core/types.js";

export const modelCall: ModelCallFn = async (options: ModelCallOptions) => {
  const [provider, ...modelParts] = options.model.split("/");
  const modelId = modelParts.join("/");

  if (provider === "google" || provider === "gemini") {
    // `||`, not `??`: these vars are routinely set-but-empty in agent
    // environments, and `??` only falls through on null/undefined. Under `??`
    // an empty GOOGLE_GENERATIVE_AI_API_KEY would mask a populated
    // GEMINI_API_KEY or GOOGLE_API_KEY below it. The pre-fix chain hit the
    // same trap one slot down, an empty GEMINI_API_KEY masking a populated
    // GOOGLE_API_KEY. `||` treats empty as absent and keeps walking.
    const apiKey =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;
    if (!apiKey)
      throw new Error(
        "No GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY in env",
      );
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: options.system }] },
          contents: options.messages.map((m) => ({
            role: "user" as const,
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            maxOutputTokens: options.maxTokens,
            temperature: options.temperature,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("No ANTHROPIC_API_KEY in env");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: options.maxTokens,
        system: options.system,
        messages: options.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? "";
  }

  throw new Error(`Unsupported provider: ${provider}`);
};
