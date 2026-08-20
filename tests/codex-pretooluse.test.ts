/**
 * Tests for the Codex PreToolUse classifier.
 *
 * Two layers:
 *  - run() unit tests: exercise the exported handler directly. Deterministic
 *    paths (allow/deny) use real static-pattern commands (no model call);
 *    ask-mapped-to-deny, classify()-throwing and config-load-failure use the
 *    optional injected deps seam (those branches are dead/non-deterministic
 *    with the real functions).
 *  - Subprocess tests: spawn the real hook entry over tsx to assert the wire
 *    contract end-to-end -- stdout JSON body AND the exit code (always 0).
 *    Hermetic: static-pattern commands (no API key) + a temp classify-mode
 *    config, so the run never depends on the developer's own
 *    ~/.io-auto-mode/config.json (which could be in yolo mode).
 *
 * The response shape asserted here is derived from the codex-rs parser
 * (codex-rs/hooks/src/engine/output_parser.rs), NOT from the outdated
 * src/hooks/preToolUse.ts JS SDK reference -- see types.ts CodexHookResponse
 * for why that distinction matters. The real contract: exit code is ALWAYS 0;
 * ALLOW is an EMPTY body ({}); DENY needs
 * hookSpecificOutput.permissionDecision:"deny" plus a non-empty
 * permissionDecisionReason.
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../adapters/codex/src/pretooluse-hook.js";
import { logDecision, setLogPath } from "../core/logger.js";
import type { ClassifierConfig, ClassifierDecision } from "../core/types.js";
import { DEFAULT_CONFIG } from "../core/types.js";
import type { CodexHookResponse } from "../adapters/codex/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Redirect the shared audit ledger to a throwaway temp file for the whole
// module. In-process run() calls write a real audit-ledger entry, and
// this guarantees they never touch the developer's real
// ~/.io-auto-mode/auto-mode-log.jsonl. Subprocess tests redirect separately
// via a temp HOME.
setLogPath(join(mkdtempSync(join(tmpdir(), "codex-hook-log-")), "log.jsonl"));

/** ALLOW is a genuinely empty body -- see the file header. */
function isAllow(res: CodexHookResponse): boolean {
  return res.hookSpecificOutput === undefined;
}

/** DENY carries permissionDecision:"deny" plus a non-empty reason. */
function isDeny(res: CodexHookResponse): boolean {
  return res.hookSpecificOutput?.permissionDecision === "deny";
}

/** A logDecision spy: records each call's args without writing anything. */
function spyLog(): {
  fn: typeof logDecision;
  calls: Array<Parameters<typeof logDecision>>;
} {
  const calls: Array<Parameters<typeof logDecision>> = [];
  const fn = ((...args: Parameters<typeof logDecision>) => {
    calls.push(args);
  }) as typeof logDecision;
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  sessionId = "test-sess",
): string {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: "turn-1",
    cwd: "/tmp",
    tool_name: toolName,
    matcher_aliases: [],
    tool_use_id: "tu-1",
    tool_input: toolInput,
  });
}

/** A fake classify that returns a fixed decision, never hitting a model. */
function fakeClassify(decision: "allow" | "ask" | "block") {
  return async (): Promise<ClassifierDecision> => ({
    decision,
    stage: "stage2",
    durationMs: 0,
  });
}

const classifyConfig: () => ClassifierConfig = () => ({
  ...DEFAULT_CONFIG,
  mode: "classify",
});

// ---------------------------------------------------------------------------
// Infra / parse errors -- fail-open (allow)
// ---------------------------------------------------------------------------

describe("codex-pretooluse: infra errors fail-open", () => {
  test("empty string returns allow", async () => {
    assert.ok(isAllow(await run("")));
  });

  test("invalid JSON returns allow", async () => {
    assert.ok(isAllow(await run("not valid json {{{")));
  });

  test("null body returns allow", async () => {
    assert.ok(isAllow(await run("null")));
  });

  test("array body returns allow", async () => {
    assert.ok(isAllow(await run("[1,2,3]")));
  });
});

// ---------------------------------------------------------------------------
// Bash allow path (real static-allow pattern -- no model call)
// ---------------------------------------------------------------------------

describe("codex-pretooluse: Bash allow path", () => {
  test("git status -> allow (static-allow)", async () => {
    const res = await run(makeRequest("Bash", { command: "git status" }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });

  test("empty command -> allow (belt-and-braces)", async () => {
    assert.ok(isAllow(await run(makeRequest("Bash", { command: "   " }))));
  });

  test("missing command field -> allow", async () => {
    assert.ok(isAllow(await run(makeRequest("Bash", {}))));
  });

  test("injected allow decision -> allow", async () => {
    const res = await run(makeRequest("Bash", { command: "some-tool --run" }), {
      classifyFn: fakeClassify("allow"),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });
});

// ---------------------------------------------------------------------------
// Bash deny path (block) -- deny needs permissionDecision:'deny' + a reason
// ---------------------------------------------------------------------------

describe("codex-pretooluse: Bash deny path (block)", () => {
  test("rm -rf / -> deny (static-block)", async () => {
    const res = await run(makeRequest("Bash", { command: "rm -rf /" }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
    assert.equal(res.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.ok(res.hookSpecificOutput?.permissionDecisionReason);
  });

  test("Bash with array command ['rm', '-rf', '/'] -> deny (static-block)", async () => {
    const res = await run(makeRequest("Bash", { command: ["rm", "-rf", "/"] }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  test("injected block decision -> deny", async () => {
    const res = await run(makeRequest("Bash", { command: "some-tool --run" }), {
      classifyFn: fakeClassify("block"),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });
});

// ---------------------------------------------------------------------------
// ask -> deny (Codex has no hook-level ask channel)
// ---------------------------------------------------------------------------

describe("codex-pretooluse: ask maps to deny", () => {
  test("injected ask decision -> deny", async () => {
    const res = await run(makeRequest("Bash", { command: "some-tool --run" }), {
      classifyFn: fakeClassify("ask"),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });
});

// ---------------------------------------------------------------------------
// Infra fail-open: config load failure, classify() throwing
// ---------------------------------------------------------------------------

describe("codex-pretooluse: classifier-path infra errors fail-open", () => {
  test("loadConfig throwing -> allow", async () => {
    const res = await run(makeRequest("Bash", { command: "some-tool --run" }), {
      loadConfigFn: () => {
        throw new Error("config boom");
      },
    });
    assert.ok(isAllow(res));
  });

  test("classify() throwing -> allow", async () => {
    const res = await run(makeRequest("Bash", { command: "some-tool --run" }), {
      classifyFn: async () => {
        throw new Error("classify boom");
      },
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });
});

// ---------------------------------------------------------------------------
// apply_patch classified -- same classify call + decision mapping as Bash
// ---------------------------------------------------------------------------

describe("codex-pretooluse: apply_patch classified", () => {
  const PATCH = "*** Begin Patch\n*** Update File: src/app.ts\n+x\n*** End Patch";

  test("injected allow -> allow", async () => {
    const res = await run(makeRequest("apply_patch", { command: PATCH }), {
      classifyFn: fakeClassify("allow"),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });

  test("injected block -> deny", async () => {
    const res = await run(makeRequest("apply_patch", { command: PATCH }), {
      classifyFn: fakeClassify("block"),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  test("injected ask -> deny (no hook-level ask)", async () => {
    const res = await run(makeRequest("apply_patch", { command: PATCH }), {
      classifyFn: fakeClassify("ask"),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  // Format-refusal abstention guard: the model sometimes blocks a benign
  // apply_patch purely because it "isn't a shell command" -- a format
  // complaint, not a risk judgement, and non-deterministic (the same benign
  // patch has been observed flipping between allow and this exact refusal
  // across back-to-back live calls at temperature 0). Static
  // analysis is the deterministic safety net for patch content and has
  // already run by this point, so a format-only refusal is treated as an
  // abstention (allow), not a real deny.
  test("format-refusal reason ('not a shell command') -> allow, not deny", async () => {
    const res = await run(makeRequest("apply_patch", { command: PATCH }), {
      classifyFn: async () => ({
        decision: "block",
        reason: "The input is a patch file, not a shell command. It cannot be classified as executable or safe.",
        stage: "stage2",
        durationMs: 0,
      }),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });

  test("format-refusal reason variant ('cannot be executed directly') -> allow", async () => {
    const res = await run(makeRequest("apply_patch", { command: PATCH }), {
      classifyFn: async () => ({
        decision: "block",
        reason: "The input is a patch file, not a shell command. It cannot be executed directly.",
        stage: "stage2",
        durationMs: 0,
      }),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });

  test("a genuine risk-based block reason is NOT caught by the format-refusal guard -> still deny", async () => {
    const res = await run(makeRequest("apply_patch", { command: PATCH }), {
      classifyFn: async () => ({
        decision: "block",
        reason: "This patch writes to ~/.bashrc, an unauthorised persistence mechanism.",
        stage: "stage2",
        durationMs: 0,
      }),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  // REGRESSION, and the reason the guard is not a substring match.
  //
  // The guard turns a deny into an allow, so a reason that carries a REAL risk
  // finding alongside the format complaint must stay a deny. Under a naive
  // `PATCH_FORMAT_REFUSAL_RE.test(reason)` every case below was silently
  // converted to allow purely because the reason CONTAINED a refusal phrase --
  // the model flagged credential exfiltration and the adapter let the patch
  // through anyway. If any of these go green as allow, the guard has been
  // loosened back to a substring match.
  const compoundRiskReasons: string[] = [
    "block: patch adds credential exfiltration and is not a shell command",
    "patch adds credential exfiltration and is not a shell command",
    "The patch appends a curl|bash payload to ~/.bashrc and is not a shell command.",
    "Not a shell command; the diff also exfiltrates AWS keys to an external endpoint.",
    "The input is a patch file, not a shell command, and it overwrites the classifier hook itself.",
  ];

  for (const reason of compoundRiskReasons) {
    test(`compound risk-plus-format reason stays DENY: ${reason.slice(0, 52)}...`, async () => {
      const res = await run(makeRequest("apply_patch", { command: PATCH }), {
        classifyFn: async () => ({
          decision: "block",
          reason,
          stage: "stage2",
          durationMs: 0,
        }),
        loadConfigFn: classifyConfig,
      });
      assert.ok(
        isDeny(res),
        `a reason carrying a real risk finding was converted to allow by the format-refusal guard: ${reason}`,
      );
      // The real reason must survive to the user, not be swallowed.
      assert.equal(res.hookSpecificOutput?.permissionDecisionReason, reason);
    });
  }

  // The other direction: a reason that IS only the format complaint, in a few
  // shapes the model actually produces, must still abstain to allow. If these
  // go red, the guard has been over-tightened and benign patches now hard-deny.
  const pureFormatReasons: string[] = [
    "not a shell command",
    "The input is a diff, not a shell command.",
    "The input is a patch file, not a shell command. It cannot be classified as executable or safe.",
  ];

  for (const reason of pureFormatReasons) {
    test(`pure format-only reason still abstains to ALLOW: ${reason.slice(0, 52)}`, async () => {
      const res = await run(makeRequest("apply_patch", { command: PATCH }), {
        classifyFn: async () => ({
          decision: "block",
          reason,
          stage: "stage2",
          durationMs: 0,
        }),
        loadConfigFn: classifyConfig,
      });
      assert.ok(isAllow(res), `format-only abstention was hard-denied: ${reason}`);
    });
  }

  test("format-refusal guard does not apply to Bash (shell commands are never format-mismatched)", async () => {
    const res = await run(makeRequest("Bash", { command: "echo hi" }), {
      classifyFn: async () => ({
        decision: "block",
        reason: "The input is a patch file, not a shell command. It cannot be classified as executable or safe.",
        stage: "stage2",
        durationMs: 0,
      }),
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  test("real static-block patch content -> deny (rm -rf /)", async () => {
    // The command field is classified verbatim -- a patch body carrying a
    // static-block command is denied (fails safe).
    const res = await run(makeRequest("apply_patch", { command: "rm -rf /" }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  test("apply_patch with array command ['apply_patch', 'rm -rf /'] -> deny (static-block)", async () => {
    const res = await run(makeRequest("apply_patch", { command: ["apply_patch", "rm -rf /"] }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isDeny(res));
  });

  test("real static-allow command -> allow (git status)", async () => {
    const res = await run(makeRequest("apply_patch", { command: "git status" }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });

  test("apply_patch with array command ['apply_patch', 'git status'] -> allow (static-allow)", async () => {
    const res = await run(makeRequest("apply_patch", { command: ["apply_patch", "git status"] }), {
      loadConfigFn: classifyConfig,
    });
    assert.ok(isAllow(res));
  });

  test("empty command -> allow (no classify)", async () => {
    const spy = spyLog();
    const res = await run(makeRequest("apply_patch", { command: "  " }), {
      logDecisionFn: spy.fn,
    });
    assert.ok(isAllow(res));
    assert.equal(spy.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Unhandled tools (MCP / missing name) -- allow + log, NO classify, NO ledger
// ---------------------------------------------------------------------------

describe("codex-pretooluse: unhandled tools allow + log", () => {
  test("an MCP tool name -> allow", async () => {
    assert.ok(isAllow(await run(makeRequest("mcp__some_server__do_thing", { x: 1 }))));
  });

  test("missing tool_name -> allow", async () => {
    assert.ok(isAllow(await run(JSON.stringify({ session_id: "s", cwd: "/tmp" }))));
  });

  test("MCP tool -> no classify, no ledger write", async () => {
    const spy = spyLog();
    let classifyCalls = 0;
    const res = await run(makeRequest("mcp__some_server__do_thing", { x: 1 }), {
      classifyFn: (async () => {
        classifyCalls += 1;
        return { decision: "allow", stage: "static", durationMs: 0 };
      }) as unknown as typeof import("../core/classifier.js").classify,
      logDecisionFn: spy.fn,
    });
    assert.ok(isAllow(res));
    assert.equal(classifyCalls, 0, "classify() must not run for an unhandled tool");
    assert.equal(spy.calls.length, 0, "no ledger write for an unhandled tool");
  });
});

// ---------------------------------------------------------------------------
// Audit-ledger write on a real classification
// ---------------------------------------------------------------------------

describe("codex-pretooluse: audit ledger", () => {
  test("Bash classification writes one ledger entry with adapter:codex", async () => {
    const spy = spyLog();
    const res = await run(makeRequest("Bash", { command: "git status" }), {
      loadConfigFn: classifyConfig,
      logDecisionFn: spy.fn,
    });
    assert.ok(isAllow(res));
    assert.equal(spy.calls.length, 1);
    const [command, result, source, identity] = spy.calls[0];
    assert.equal(command, "git status");
    assert.equal(result.decision, "allow");
    assert.equal(source, "direct");
    assert.deepEqual(identity, { adapter: "codex" });
  });

  test("Bash deny also writes a ledger entry (decision=block)", async () => {
    const spy = spyLog();
    const res = await run(makeRequest("Bash", { command: "rm -rf /" }), {
      loadConfigFn: classifyConfig,
      logDecisionFn: spy.fn,
    });
    assert.ok(isDeny(res));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0][1].decision, "block");
    assert.deepEqual(spy.calls[0][3], { adapter: "codex" });
  });

  test("apply_patch classification writes a ledger entry", async () => {
    const spy = spyLog();
    await run(makeRequest("apply_patch", { command: "git status" }), {
      loadConfigFn: classifyConfig,
      logDecisionFn: spy.fn,
    });
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0][3], { adapter: "codex" });
  });

  test("a ledger-write failure is non-fatal and does not change the decision", async () => {
    const res = await run(makeRequest("Bash", { command: "rm -rf /" }), {
      loadConfigFn: classifyConfig,
      logDecisionFn: (() => {
        throw new Error("ledger boom");
      }) as typeof logDecision,
    });
    // Deny still emitted despite the log throwing.
    assert.ok(isDeny(res));
  });
});

// ---------------------------------------------------------------------------
// Wire-contract shape
// ---------------------------------------------------------------------------

describe("codex-pretooluse: response shapes", () => {
  test("allow body is exactly {}", async () => {
    const res = await run(makeRequest("mcp__some_server__do_thing", {}));
    assert.deepEqual(res, {});
  });

  test("deny body is {hookSpecificOutput:{hookEventName,permissionDecision:'deny',permissionDecisionReason}}", async () => {
    const res = await run(makeRequest("Bash", { command: "rm -rf /" }), {
      loadConfigFn: classifyConfig,
    });
    assert.equal(res.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.equal(res.hookSpecificOutput?.permissionDecision, "deny");
    assert.ok(
      typeof res.hookSpecificOutput?.permissionDecisionReason === "string" &&
        res.hookSpecificOutput.permissionDecisionReason.length > 0,
    );
  });
});

// ---------------------------------------------------------------------------
// Subprocess: real hook entry -- stdout body AND exit code together
// ---------------------------------------------------------------------------

describe("codex-pretooluse: subprocess wire + exit-code contract", () => {
  const TSX = resolve(ROOT, "node_modules/.bin/tsx");
  const HOOK = resolve(ROOT, "adapters/codex/src/pretooluse-hook.ts");

  // Hermetic classify-mode config so static patterns govern, independent of
  // the developer's own ~/.io-auto-mode/config.json (which could be yolo).
  const cfgDir = mkdtempSync(join(tmpdir(), "codex-hook-test-"));
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ mode: "classify" }));

  // Redirect the shared audit ledger away from the developer's real one.
  // main() calls setLogPath(resolve(homedir(), ".io-auto-mode", ...)), so a
  // temp HOME sends every ledger write under a throwaway dir instead.
  const tmpHome = mkdtempSync(join(tmpdir(), "codex-hook-home-"));

  function invoke(payload: string) {
    return spawnSync(TSX, [HOOK], {
      input: payload,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpHome, IO_AUTO_MODE_CONFIG: cfgPath },
    });
  }

  test("deny: exit code 0 AND deny body (rm -rf /)", () => {
    const r = invoke(makeRequest("Bash", { command: "rm -rf /" }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(body.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.ok(body.hookSpecificOutput.permissionDecisionReason);
  });

  test("allow: exit code 0 AND empty body (git status)", () => {
    const r = invoke(makeRequest("Bash", { command: "git status" }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(body, {});
  });

  test("apply_patch deny: exit code 0 AND deny body (rm -rf /)", () => {
    const r = invoke(makeRequest("apply_patch", { command: "rm -rf /" }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
  });

  test("apply_patch allow: exit code 0 AND empty body (git status)", () => {
    const r = invoke(makeRequest("apply_patch", { command: "git status" }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(body, {});
  });

  test("unhandled MCP tool: exit code 0 AND empty body (no classify)", () => {
    const r = invoke(makeRequest("mcp__some_server__do_thing", { x: 1 }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(body, {});
  });

  test("unparseable stdin: exit code 0 AND empty body (fail-open)", () => {
    const r = invoke("not json {{{");
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(body, {});
  });

  // Audit ledger end-to-end: exercise the REAL production path (main()'s setLogPath +
  // the default logDecisionFn binding + logDecision itself), not an injected
  // spy. The temp HOME sends the write under a throwaway dir; assert the entry
  // actually landed and is tagged adapter:codex.
  test("production path writes a real ledger entry tagged adapter:codex", () => {
    const r = invoke(makeRequest("Bash", { command: "git status" }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    const ledger = join(tmpHome, ".io-auto-mode", "auto-mode-log.jsonl");
    const last = JSON.parse(
      readFileSync(ledger, "utf-8").trim().split("\n").pop() as string,
    );
    assert.equal(last.adapter, "codex");
    assert.equal(last.command, "git status");
    assert.equal(last.decision, "allow");
    assert.equal(last.source, "direct");
  });
});
