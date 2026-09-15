/**
 * io-auto-mode -- Antigravity (agy) PreToolUse safety classifier.
 *
 * Mirrors the Claude Code PreToolUse hook but adapted for agy's bool-result
 * contract and the agy hook env. Gates an agy agent's tool calls through the
 * same io-auto-mode classifier that gates Claude Code agents.
 *
 * Decision mapping:
 *   run_command: classify args.CommandLine -> allow->true, block->false, ask->false
 *   mcp__server__tool: classify redacted structured args -> same bool mapping
 *   read-only / agy-internal tools -> allow (no classify call)
 *   unknown tool -> allow + LOUD warn log (captures real shapes for future review)
 *
 * Output is EXACTLY {"allowTool": bool} -- no other fields ever.
 * agy unmarshals via protojson which is STRICT: any extra field fails the
 * entire unmarshal -> agy defaults to allow. Bare allowTool is the only safe shape.
 *
 * Fail-open on INFRA errors (unparseable payload, config load failure, any
 * uncaught exception): emit {"allowTool":true} + loud log. A broken classifier
 * must never hard-brick the agent. The classifier's own clean block/ask
 * decisions ARE honored -- classify() never throws on model failure.
 */

// Load API keys before any other imports.
// Hook subprocesses don't inherit the user's full shell env.
// Search order (first match wins):
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
import { classifyMcpCall, parseMcpToolName } from "../../../core/mcp.js";
import { logDecision, setLogPath } from "../../../core/logger.js";
import { DEFAULT_CONFIG } from "../../../core/types.js";
import type { ClassifierConfig, ClassifierDecision } from "../../../core/types.js";
import { modelCall } from "../../claude-code/src/model-call.js";
import type { AgyPreToolUseInput, AgyPreToolResult } from "./types.js";

// Tools that are read-only or agy-internal: always allow, no classify call.
const ALLOW_TOOLS = new Set([
  // read-only
  "view_file",
  "list_dir",
  "read_url_content",
  "search_web",
  "grep_search",
  "codebase_search",
  "find_filepath",
  // agy-internal
  "ask_permission",
  "ask_question",
  "list_permissions",
  "invoke_subagent",
]);

// --- Config loader (mirrors adapters/claude-code/src/hook.ts) ---
function loadConfig(): ClassifierConfig {
  const candidates = [
    process.env.IO_AUTO_MODE_CONFIG,
    resolve(homedir(), ".io-auto-mode", "config.json"),
    process.env.AGY_PLUGIN_ROOT
      ? resolve(process.env.AGY_PLUGIN_ROOT, "config.json")
      : null,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ClassifierConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (path === process.env.IO_AUTO_MODE_CONFIG || code !== "ENOENT") throw err;
      // Missing optional candidate: try the next path.
    }
  }
  return DEFAULT_CONFIG;
}

// --- Emit helpers ---
const ALLOW: AgyPreToolResult = { allowTool: true };
const BLOCK: AgyPreToolResult = { allowTool: false };

function emitAndExit(result: AgyPreToolResult): never {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export interface RunDeps {
  classifyFn?: typeof classify;
  loadConfigFn?: () => ClassifierConfig;
  logDecisionFn?: typeof logDecision;
}

// --- Core handler (exported for unit tests) ---
export async function run(rawInput: string, deps: RunDeps = {}): Promise<AgyPreToolResult> {
  const classifyFn = deps.classifyFn ?? classify;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const logDecisionFn = deps.logDecisionFn ?? logDecision;
  let input: AgyPreToolUseInput;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          component: "agy-pretooluse-classify",
          event: "infra-error-fail-open",
          msg: "stdin is not an object -- failing open",
        }) + "\n",
      );
      return ALLOW;
    }
    input = parsed as AgyPreToolUseInput;
  } catch {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        component: "agy-pretooluse-classify",
        event: "infra-error-fail-open",
        msg: "unparseable stdin -- failing open",
      }) + "\n",
    );
    return ALLOW;
  }

  const toolName = input.toolCall?.name ?? "";
  const mcpIdentity = parseMcpToolName(toolName);

  if (mcpIdentity) {
    let config: ClassifierConfig;
    try {
      config = loadConfigFn();
    } catch (err) {
      process.stderr.write(JSON.stringify({
        level: "warn",
        component: "agy-pretooluse-classify",
        event: "infra-error-fail-closed",
        msg: `MCP config load failed: ${(err as Error).message}`,
        sessionId: input.conversationId,
        toolName,
      }) + "\n");
      return BLOCK;
    }

    let action: string;
    let result: ClassifierDecision;
    try {
      ({ action, result } = await classifyMcpCall({
        toolName: mcpIdentity.canonicalName,
        toolInput: input.toolCall?.args,
        transcript: [],
        modelCall,
        config,
        isMainSession: true,
        source: "direct",
        classifyFn,
      }));
    } catch (err) {
      process.stderr.write(JSON.stringify({
        level: "warn",
        component: "agy-pretooluse-classify",
        event: "infra-error-fail-closed",
        msg: `MCP classifier failed: ${(err as Error).message}`,
        sessionId: input.conversationId,
        toolName,
      }) + "\n");
      return BLOCK;
    }

    try {
      logDecisionFn(action, result, "direct", { adapter: "antigravity" });
    } catch { /* logging is non-fatal */ }

    process.stderr.write(JSON.stringify({
      level: "info",
      component: "agy-pretooluse-classify",
      event: "classified",
      sessionId: input.conversationId,
      toolName,
      decision: result.decision,
      stage: result.stage,
    }) + "\n");
    return result.decision === "allow" ? ALLOW : BLOCK;
  }

  // Read-only and agy-internal tools: always allow.
  if (ALLOW_TOOLS.has(toolName)) {
    return ALLOW;
  }

  // run_command: classify the command line.
  if (toolName === "run_command") {
    const cmdLine = (input.toolCall?.args?.CommandLine as string | undefined)?.trim() ?? "";
    if (!cmdLine) {
      // Empty CommandLine -- safer to allow.
      return ALLOW;
    }

    let config: ClassifierConfig;
    try {
      config = loadConfigFn();
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          component: "agy-pretooluse-classify",
          event: "infra-error-fail-open",
          msg: `loadConfig threw -- failing open: ${(err as Error).message}`,
          sessionId: input.conversationId,
        }) + "\n",
      );
      return ALLOW;
    }

    let decision: string;
    try {
      const result = await classifyFn(cmdLine, [], modelCall, config, {
        isMainSession: true,
        source: "direct",
      });
      decision = result.decision;

      process.stderr.write(
        JSON.stringify({
          level: "info",
          component: "agy-pretooluse-classify",
          event: "classified",
          sessionId: input.conversationId,
          cmd: cmdLine.slice(0, 120),
          decision: result.decision,
          stage: result.stage,
        }) + "\n",
      );
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          component: "agy-pretooluse-classify",
          event: "infra-error-fail-open",
          msg: `classify() threw unexpectedly -- failing open: ${(err as Error).message}`,
          sessionId: input.conversationId,
        }) + "\n",
      );
      return ALLOW;
    }

    // allow -> true; block -> false; ask -> false (conservative: no human-ask channel).
    if (decision === "allow") return ALLOW;
    return BLOCK;
  }

  // Unknown / unhandled tool: allow + LOUD warn (captures real shapes for future review).
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      component: "agy-pretooluse-classify",
      event: "unknown-tool-allow",
      msg: `unknown agy tool name -- allowing and logging for review: ${toolName}`,
      sessionId: input.conversationId,
      toolName,
    }) + "\n",
  );
  return ALLOW;
}

// --- Main entry (only runs when invoked as a script) ---
async function main(): Promise<void> {
  setLogPath(resolve(homedir(), ".io-auto-mode", "auto-mode-log.jsonl"));
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        component: "agy-pretooluse-classify",
        event: "infra-error-fail-open",
        msg: `failed to read stdin -- failing open: ${(err as Error).message}`,
      }) + "\n",
    );
    emitAndExit(ALLOW);
  }

  try {
    emitAndExit(await run(raw));
  } catch (err) {
    // Top-level catch: infra fail-open.
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        component: "agy-pretooluse-classify",
        event: "infra-error-fail-open",
        msg: `unhandled top-level error -- failing open: ${(err as Error).message}`,
      }) + "\n",
    );
    emitAndExit(ALLOW);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("pretooluse-classify.js") ||
  process.argv[1]?.endsWith("pretooluse-classify.ts");

if (isMain) {
  void main();
}
