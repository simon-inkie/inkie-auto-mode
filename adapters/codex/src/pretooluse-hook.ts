/**
 * io-auto-mode -- Codex PreToolUse safety classifier.
 *
 * Mirrors the Antigravity (agy) PreToolUse hook, adapted for Codex's wire
 * contract. Gates a Codex agent's tool calls through the same io-auto-mode
 * classifier that gates every Claude Code agent.
 *
 * WIRE CONTRACT -- READ THIS BEFORE CHANGING THE OUTPUT SHAPE. The intuitive
 * contract (block:true + exit 2) is WRONG. It matches src/hooks/preToolUse.ts,
 * a JS SDK reference that does NOT match the codex-rs runtime that actually
 * parses this hook's output. Against a real Codex that shape fails every
 * invocation ("hook returned invalid pre-tool-use JSON output", or after a
 * partial fix "unsupported permissionDecision:allow"), which means the deny
 * path silently never blocks anything. The contract below is derived from the
 * parser itself (codex-rs/hooks/src/engine/output_parser.rs +
 * codex-rs/hooks/src/events/pre_tool_use.rs):
 *   - Exit code is ALWAYS 0. Exit 2 routes to a totally different codepath
 *     that ignores stdout JSON entirely and reads stderr as a raw block
 *     reason instead -- our stderr carries an unrelated info log, so exit 2
 *     silently discarded our real decision.
 *   - ALLOW is signalled by an EMPTY body ({}) or omitting hookSpecificOutput
 *     entirely. Explicitly emitting permissionDecision:"allow" without a
 *     paired updatedInput rewrite is itself REJECTED as unsupported (a hook
 *     only exists to block; explicit allow is only valid alongside a command
 *     rewrite, which we don't do).
 *   - DENY needs hookSpecificOutput.permissionDecision:"deny" PLUS a
 *     non-empty permissionDecisionReason string -- an empty/missing reason is
 *     also rejected as invalid.
 *
 * Decision mapping (three-state classifier -> Codex's contract):
 *   Bash and apply_patch: classify tool_input.command
 *     allow -> {} (exit 0)
 *     block -> deny with reason (exit 0)
 *     ask   -> deny with reason (exit 0)  -- Codex has no hook-level ask state;
 *              matches the Antigravity precedent (conservative: with no
 *              human-ask channel, an escalated command is refused rather
 *              than silently allowed).
 *   MCP tools: apply explicit server/tool-name policy, then classify a
 *     structured and credential-redacted action through the MCP prompt.
 *   Any other tool -> allow + LOUD warn log (name and input keys only).
 *
 * Classified scope: tool_name === "Bash", "apply_patch", or a canonical
 * "mcp__server__tool" name. Verified against
 * codex-rs/core/src/hook_runtime.rs: run_pre_tool_use_hooks special-cases both
 * "Bash" and "apply_patch" and reads tool_input.get("command") for each, so both
 * carry the command/patch content under the same `command` field. Classifying
 * apply_patch closes an otherwise wide-open bypass: a patch can write a
 * malicious script, overwrite the hook itself, or append to ~/.bashrc,
 * laundering the real payload past a Bash-only gate. Bash has zero
 * matcher_aliases (hook_names.rs), so the canonical-name check is complete.
 * NOTE: apply_patch's command is the raw patch text; it is classified verbatim
 * (no tool-label prefix) for consistency with Bash. Static BLOCK patterns are
 * substring-matched, so a patch body containing shell-looking text can
 * false-positive-deny a legitimate edit -- that fails safe, and classifying the
 * patch content is the whole point. Benign patches match no ^-anchored static
 * ALLOW and fall through to the LLM, which allows them, so normal editing is
 * not bricked.
 *
 * Audit ledger: every classified decision is written to the shared
 * ~/.io-auto-mode/auto-mode-log.jsonl ledger via logDecision(..., {adapter:
 * "codex"}), mirroring the Claude Code adapter. A log-write failure is non-fatal
 * and never changes the emitted response.
 *
 * Fail-OPEN on shell/patch INFRA errors (unparseable stdin, config load failure,
 * classify() throwing unexpectedly, any uncaught exception): allow + loud
 * stderr warn log. MCP config/classifier failures fail CLOSED because operators
 * may set Codex's native MCP approval mode to approve and rely on this hook as
 * the active decision boundary.
 * A broken classifier must never hard-brick the agent. The classifier's own
 * clean block/ask decisions ARE honoured -- classify() never throws on a model
 * failure (it has its own fail-closed logic). This matches both existing
 * adapters exactly.
 */

// Load API keys before any other imports. Hook subprocesses don't inherit the
// user's full shell env. Search order (first match wins):
//   1. ~/.io-auto-mode/.env  (canonical -- sits next to the user's config)
//   2. ~/io-data/.env        (legacy convention, kept for back-compat)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const ENV_PATHS = [
  resolve(homedir(), ".io-auto-mode", ".env"),
  resolve(homedir(), "io-data", ".env"),
];
for (const envPath of ENV_PATHS) {
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#]\w*)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
    break; // first match wins
  } catch {
    /* try next path */
  }
}

import { classify } from "../../../core/classifier.js";
import {
  evaluateMcpPolicy,
  formatMcpAction,
  parseMcpToolName,
} from "../../../core/mcp.js";
import { logDecision, setLogPath } from "../../../core/logger.js";
import { DEFAULT_CONFIG } from "../../../core/types.js";
import type { ClassifierConfig, ClassifierDecision } from "../../../core/types.js";
import { modelCall } from "../../claude-code/src/model-call.js";
import type { CodexHookResponse, CodexPreToolUseRequest } from "./types.js";

// --- Config loader (mirrors adapters/claude-code/src/hook.ts) ---
function loadConfig(): ClassifierConfig {
  const candidates = [
    process.env.IO_AUTO_MODE_CONFIG,
    resolve(homedir(), ".io-auto-mode", "config.json"),
    process.env.CODEX_ADAPTER_ROOT
      ? resolve(process.env.CODEX_ADAPTER_ROOT, "config.json")
      : null,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ClassifierConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      // try next candidate
    }
  }
  return DEFAULT_CONFIG;
}

// --- Response constants ---
// See types.ts CodexHookResponse for the full wire contract. ALLOW is a
// genuinely empty body -- emitting permissionDecision:"allow" explicitly is
// itself rejected by Codex's parser unless paired with an input rewrite,
// which this adapter never does.
const ALLOW: CodexHookResponse = {};

// apply_patch format-refusal guard. The classifier's system prompt is
// shell-shaped, so for a benign apply_patch the model sometimes refuses purely
// because the input "isn't a shell command" rather than judging the patch's
// actual risk -- a format complaint, not a security decision, and
// non-deterministic (the same benign documentation patch has been observed
// flipping between allow and this refusal across back-to-back calls at
// temperature 0). See run() below for where this is applied and why it is safe
// to treat as an abstention rather than a real deny.
//
// THIS GUARD MUST NEVER BE A SUBSTRING MATCH. It converts a deny into an
// allow, so any reason that carries real risk content ALONGSIDE the format
// complaint must stay a deny. A naive `.test(reason)` turns
//   "patch adds credential exfiltration and is not a shell command"
// into an allow, because it merely CONTAINS a refusal phrase. The reason must
// BE the format complaint and nothing else.
//
// The check is therefore subtractive and closed by default: remove the known
// refusal phrases and the benign framing the model wraps them in, then require
// that every token left over is inert filler. Any unrecognised word -- any
// noun that could be carrying a risk finding -- fails the check and the deny
// stands. Widening FORMAT_FILLER_RE is a security-relevant edit.

/** Phrases that ARE the format complaint. At least one must be present. */
const FORMAT_REFUSAL_PHRASES: RegExp[] = [
  /\bnot\s+(?:a\s+)?shell\s+command\b/gi,
  /\bcannot\s+be\s+classified\s+as\s+(?:executable|safe)(?:\s+(?:or|nor|and)\s+(?:executable|safe))?\b/gi,
  /\bcannot\s+be\s+executed\s+directly\b/gi,
];

/**
 * Benign framing the model wraps the complaint in ("the input is a patch
 * file, ..."). Permitted, but never sufficient on its own -- a reason made
 * only of framing contains no refusal and is not an abstention.
 */
const FORMAT_FRAMING_PHRASES: RegExp[] = [
  /\b(?:the\s+|this\s+|it\s+)?(?:input|content|text|command|body)?\s*is\s+(?:a\s+)?(?:raw\s+)?(?:unified\s+)?(?:patch(?:\s+file)?|diff(?:\s+file)?)\b/gi,
];

/**
 * Tokens allowed to remain once the phrases above are removed. Deliberately
 * tiny: determiners, copulas and connectives only. No nouns that could carry
 * a risk finding, no verbs of action.
 */
const FORMAT_FILLER_RE =
  /^(?:the|this|that|it|its|a|an|is|are|was|be|and|or|so|therefore|thus|hence|rather|than|as|only|just|merely|simply|input|content|text|patch|diff|file|body)$/i;

function isPatchFormatRefusal(reason: string | undefined): boolean {
  if (reason === undefined) return false;

  // 1. A refusal phrase must actually be present.
  let residue = reason;
  let sawRefusal = false;
  for (const re of FORMAT_REFUSAL_PHRASES) {
    re.lastIndex = 0;
    const stripped = residue.replace(re, " ");
    if (stripped !== residue) sawRefusal = true;
    residue = stripped;
  }
  if (!sawRefusal) return false;

  // 2. Strip the benign framing the complaint is usually wrapped in.
  for (const re of FORMAT_FRAMING_PHRASES) {
    re.lastIndex = 0;
    residue = residue.replace(re, " ");
  }

  // 3. Everything left must be inert filler. One unrecognised word -- e.g.
  //    "exfiltration", "bashrc", "credential" -- and the deny stands.
  const leftovers = residue.split(/[^A-Za-z']+/).filter((t) => t.length > 0);
  return leftovers.every((token) => FORMAT_FILLER_RE.test(token));
}

function denyResponse(reason: string): CodexHookResponse {
  // A non-empty reason is REQUIRED -- Codex rejects deny without one.
  const trimmed = reason.trim();
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: trimmed || "Blocked by io-auto-mode classifier",
    },
  };
}

/**
 * Optional dependency injection seam -- FOR TESTS ONLY. Production main() calls
 * run(raw) with no deps, so the runtime path is byte-for-byte the Antigravity
 * pattern (real classify + real loadConfig). The seam exists purely to hit the
 * ask-mapped-to-deny, classify()-throwing, and config-load-failure branches
 * deterministically: with the real functions those branches are either
 * non-deterministic (model-dependent) or dead (classify/loadConfig never throw).
 */
export interface RunDeps {
  classifyFn?: typeof classify;
  loadConfigFn?: () => ClassifierConfig;
  logDecisionFn?: typeof logDecision;
}

function warn(event: string, extra: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      component: "codex-pretooluse-hook",
      event,
      ...extra,
    }) + "\n",
  );
}

// --- Core handler (exported for unit tests) ---
export async function run(
  rawInput: string,
  deps: RunDeps = {},
): Promise<CodexHookResponse> {
  const classifyFn = deps.classifyFn ?? classify;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const logDecisionFn = deps.logDecisionFn ?? logDecision;

  let input: CodexPreToolUseRequest;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn("infra-error-fail-open", {
        msg: "stdin is not an object -- failing open",
      });
      return ALLOW;
    }
    input = parsed as CodexPreToolUseRequest;
  } catch {
    warn("infra-error-fail-open", { msg: "unparseable stdin -- failing open" });
    return ALLOW;
  }

  const toolName = input.tool_name ?? "";

  const mcpIdentity = parseMcpToolName(toolName);
  if (mcpIdentity) {
    let config: ClassifierConfig;
    try {
      config = loadConfigFn();
    } catch (err) {
      warn("infra-error-fail-open", {
        msg: `loadConfig threw for MCP tool -- failing closed: ${(err as Error).message}`,
        sessionId: input.session_id,
        toolName,
      });
      return denyResponse("MCP classifier configuration unavailable");
    }

    const action = formatMcpAction(mcpIdentity, input.tool_input);
    let result: ClassifierDecision;
    try {
      result = evaluateMcpPolicy(mcpIdentity, config) ?? await classifyFn(
        action,
        [],
        modelCall,
        config,
        { isMainSession: true, source: "direct", actionKind: "mcp" },
      );
    } catch (err) {
      warn("infra-error-fail-open", {
        msg: `MCP classify() threw unexpectedly -- failing closed: ${(err as Error).message}`,
        sessionId: input.session_id,
        toolName,
      });
      return denyResponse("MCP classifier unavailable");
    }

    process.stderr.write(
      JSON.stringify({
        level: "info",
        component: "codex-pretooluse-hook",
        event: "classified",
        sessionId: input.session_id,
        toolName,
        decision: result.decision,
        stage: result.stage,
      }) + "\n",
    );

    try {
      logDecisionFn(action, result, "direct", { adapter: "codex" });
    } catch {
      // Logging failure must not affect classification.
    }

    if (result.decision === "allow") return ALLOW;
    return denyResponse(
      result.reason ?? `Blocked by io-auto-mode MCP classifier (${result.decision})`,
    );
  }

  // Bash and apply_patch both carry the command/patch content under
  // tool_input.command (hook_runtime.rs reads tool_input.get("command") for
  // both). Classify each the same way; apply_patch coverage closes the
  // patch-laundering bypass described in the file header. Bash has zero
  // matcher_aliases, so the canonical-name check is complete for the shell tool.
  if (toolName === "Bash" || toolName === "apply_patch") {
    let command = "";
    const rawCommand = input.tool_input?.command as unknown;
    if (typeof rawCommand === "string") {
      command = rawCommand.trim();
    } else if (Array.isArray(rawCommand)) {
      const arr = rawCommand as unknown[];
      if (toolName === "apply_patch") {
        if (arr.length === 2 && arr[0] === "apply_patch") {
          command = String(arr[1] ?? "").trim();
        } else {
          command = arr.map((val: unknown) => String(val ?? "")).join("\n");
        }
      } else if (toolName === "Bash") {
        command = arr.map((val: unknown) => String(val ?? "")).join(" ");
      }
    }
    if (!command) {
      // No command/patch to classify -- safer to allow empty/absent than deny.
      // Log loudly: an empty command on a normally-classified tool is unusual.
      warn("classified-empty-command-allow", {
        msg: `${toolName} with empty command -- allowing`,
        sessionId: input.session_id,
        toolName,
      });
      return ALLOW;
    }

    let config: ClassifierConfig;
    try {
      config = loadConfigFn();
    } catch (err) {
      warn("infra-error-fail-open", {
        msg: `loadConfig threw -- failing open: ${(err as Error).message}`,
        sessionId: input.session_id,
      });
      return ALLOW;
    }

    let result;
    try {
      result = await classifyFn(command, [], modelCall, config, {
        isMainSession: true,
        source: "direct",
      });

      process.stderr.write(
        JSON.stringify({
          level: "info",
          component: "codex-pretooluse-hook",
          event: "classified",
          sessionId: input.session_id,
          toolName,
          cmd: command.slice(0, 120),
          decision: result.decision,
          stage: result.stage,
        }) + "\n",
      );
    } catch (err) {
      warn("infra-error-fail-open", {
        msg: `classify() threw unexpectedly -- failing open: ${(err as Error).message}`,
        sessionId: input.session_id,
      });
      return ALLOW;
    }

    // Write the decision to the shared audit ledger. A log-write failure
    // is non-fatal and never changes the emitted response (mirrors claude-code).
    try {
      logDecisionFn(command, result, "direct", { adapter: "codex" });
    } catch {
      // Logging failure must not affect classification.
    }

    // allow -> allow; block -> deny; ask -> deny (no hook-level ask channel).
    if (result.decision === "allow") return ALLOW;

    // apply_patch abstention: static analysis (evaluateStatic, run inside
    // classify() before any model call) is the deterministic safety net for
    // patch content -- both known-dangerous test patches (bashrc curl|bash,
    // credential exfil) were caught there, before the LLM was even
    // consulted. So when the LLM's only objection is that the input doesn't
    // look like a shell command, that's not a risk judgement to honour --
    // treat it as an abstention already covered by static, not a real deny.
    if (toolName === "apply_patch" && isPatchFormatRefusal(result.reason)) {
      warn("apply-patch-format-refusal-allow", {
        msg: "classifier refused apply_patch on format grounds (not a risk judgement) -- static analysis already cleared this patch, allowing",
        sessionId: input.session_id,
        modelReason: result.reason,
      });
      return ALLOW;
    }

    return denyResponse(
      result.reason ?? `Blocked by io-auto-mode classifier (${result.decision})`,
    );
  }

  // Any other unhandled tool: allow + LOUD warn. Log keys, never raw values:
  // arbitrary tool inputs may contain credentials or private content.
  warn("unhandled-tool-allow", {
    msg: `unknown non-MCP tool is not classified -- allowing and logging for review: ${toolName}`,
    sessionId: input.session_id,
    toolName,
    toolInputKeys: Object.keys(input.tool_input ?? {}),
  });
  return ALLOW;
}

// --- Emit + exit ---
// Deny is carried entirely by the JSON body (permissionDecision:"deny" + a
// non-empty reason); exit code is always 0. The stdout write callback fires
// after the buffer flushes, so exit never truncates the response body (a
// truncated deny would be mis-parsed by Codex and fail open -- letting the
// dangerous command run).
function emitAndExit(res: CodexHookResponse): void {
  // Exit code is ALWAYS 0 -- see the file header for why exit 2 is wrong
  // under the real codex-rs contract (it routes to a stderr-only codepath
  // that ignores this JSON body entirely, silently discarding the decision).
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(res) + "\n", () => {
    process.exit(0);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// --- Main entry (only runs when invoked as a script) ---
async function main(): Promise<void> {
  // Route audit-ledger writes to the shared user-wide path so every Codex
  // invocation appends to the same file regardless of cwd (mirrors claude-code).
  setLogPath(resolve(homedir(), ".io-auto-mode", "auto-mode-log.jsonl"));

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    warn("infra-error-fail-open", {
      msg: `failed to read stdin -- failing open: ${(err as Error).message}`,
    });
    return emitAndExit(ALLOW);
  }

  try {
    emitAndExit(await run(raw));
  } catch (err) {
    // Top-level catch: infra fail-open.
    warn("infra-error-fail-open", {
      msg: `unhandled top-level error -- failing open: ${(err as Error).message}`,
    });
    emitAndExit(ALLOW);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pretooluse-hook.js") ||
  process.argv[1]?.endsWith("pretooluse-hook.ts");

if (isMain) {
  void main();
}
