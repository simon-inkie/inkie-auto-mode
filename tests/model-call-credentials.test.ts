/**
 * Regression guard for the Google credential lookup in the adapter model-call
 * layer.
 *
 * Origin: the classifier can be silently dead while a perfectly good
 * credential sits in the environment. The adapters only read GEMINI_API_KEY /
 * GOOGLE_API_KEY, but GOOGLE_GENERATIVE_AI_API_KEY is the canonical supported
 * name, so modelCall threw before any network call and classify() degraded to
 * its stage:"error" path on every exec.
 *
 * Two outcomes are protected here:
 *   1. The canonical GOOGLE_GENERATIVE_AI_API_KEY is READ, and read FIRST.
 *   2. An ambient EMPTY-STRING var does not mask a populated later candidate.
 *      That is why the chain uses `||` and not `??`. `??` only falls through
 *      on null/undefined, so under `??` an empty GOOGLE_GENERATIVE_AI_API_KEY
 *      would mask a populated GEMINI_API_KEY/GOOGLE_API_KEY below it. The
 *      pre-fix chain hit the same trap one slot down: an empty GEMINI_API_KEY
 *      masked a populated GOOGLE_API_KEY, taking the classifier down with a
 *      perfectly good credential sitting in the environment.
 *
 * These are deterministic unit tests over the credential-selection logic: the
 * key that ends up on the wire is asserted by stubbing global fetch. They do
 * NOT prove the model endpoint is live -- that is a real-API concern, covered
 * separately by live verification against the Gemini API.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { modelCall } from "../adapters/claude-code/src/model-call.js";
import { modelCall as cursorModelCall } from "../adapters/cursor/src/model-call.js";

const KEY_VARS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

const originalEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

/** Captures the key query param off the outgoing request, then short-circuits. */
function stubFetch(): { keys: string[] } {
  const captured: { keys: string[] } = { keys: [] };
  globalThis.fetch = (async (url: string | URL) => {
    const match = String(url).match(/[?&]key=([^&]*)/);
    captured.keys.push(match ? match[1] : "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ALLOW" }] } }] }),
      text: async () => "",
    };
  }) as unknown as typeof globalThis.fetch;
  return captured;
}

function setEnv(vars: Partial<Record<(typeof KEY_VARS)[number], string | undefined>>): void {
  for (const v of KEY_VARS) {
    const val = vars[v];
    if (val === undefined) delete process.env[v];
    else process.env[v] = val;
  }
}

const OPTS = {
  model: "google/gemini-3.1-flash-lite",
  system: "s",
  messages: [{ role: "user" as const, content: "c" }],
  maxTokens: 8,
  temperature: 0,
};

describe("model-call: Google credential resolution", () => {
  beforeEach(() => {
    for (const v of KEY_VARS) originalEnv[v] = process.env[v];
  });

  afterEach(() => {
    for (const v of KEY_VARS) {
      if (originalEnv[v] === undefined) delete process.env[v];
      else process.env[v] = originalEnv[v]!;
    }
    globalThis.fetch = realFetch;
  });

  test("canonical GOOGLE_GENERATIVE_AI_API_KEY alone is enough to reach the API", async () => {
    setEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "canonical-key" });
    const cap = stubFetch();
    await modelCall(OPTS);
    assert.deepEqual(cap.keys, ["canonical-key"]);
  });

  test("canonical key wins when every candidate is populated", async () => {
    setEnv({
      GOOGLE_GENERATIVE_AI_API_KEY: "canonical-key",
      GEMINI_API_KEY: "legacy-gemini",
      GOOGLE_API_KEY: "legacy-google",
    });
    const cap = stubFetch();
    await modelCall(OPTS);
    assert.deepEqual(cap.keys, ["canonical-key"]);
  });

  test("an empty-string canonical var falls through to the populated legacy key", async () => {
    setEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "", GEMINI_API_KEY: "legacy-gemini" });
    const cap = stubFetch();
    await modelCall(OPTS);
    assert.deepEqual(cap.keys, ["legacy-gemini"]);
  });

  test("an empty-string GEMINI_API_KEY does not mask a populated GOOGLE_API_KEY", async () => {
    setEnv({ GEMINI_API_KEY: "", GOOGLE_API_KEY: "legacy-google" });
    const cap = stubFetch();
    await modelCall(OPTS);
    assert.deepEqual(cap.keys, ["legacy-google"]);
  });

  test("legacy-only environments keep working (back-compat)", async () => {
    setEnv({ GEMINI_API_KEY: "legacy-gemini" });
    const cap = stubFetch();
    await modelCall(OPTS);
    assert.deepEqual(cap.keys, ["legacy-gemini"]);
  });

  test("no credential at all throws naming all three accepted vars", async () => {
    setEnv({});
    stubFetch();
    await assert.rejects(
      () => modelCall(OPTS),
      (err: Error) => {
        assert.match(err.message, /GOOGLE_GENERATIVE_AI_API_KEY/);
        assert.match(err.message, /GEMINI_API_KEY/);
        assert.match(err.message, /GOOGLE_API_KEY/);
        return true;
      },
    );
  });

  test("all-empty-string credentials are treated as absent, not as a valid key", async () => {
    setEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" });
    const cap = stubFetch();
    await assert.rejects(() => modelCall(OPTS));
    assert.deepEqual(cap.keys, [], "must not put an empty key on the wire");
  });

  test("the cursor adapter resolves credentials identically", async () => {
    setEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "canonical-key", GEMINI_API_KEY: "" });
    const cap = stubFetch();
    await cursorModelCall(OPTS);
    assert.deepEqual(cap.keys, ["canonical-key"]);
  });
});
