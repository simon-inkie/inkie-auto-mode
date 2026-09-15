/**
 * io-auto-mode — Cursor shell and MCP execution hook handler.
 *
 * Flow:
 *   stdin → Cursor hook event JSON → extract shell command or MCP action
 *     → load cached user prompt for this conversation (if any) for context
 *     → serialise to the core classifier's TranscriptEntry shape
 *     → run classify() — static patterns + Stage 1 (fast LLM) + Stage 2 (thinking)
 *     → map core's Decision (allow/ask/block) → Cursor's permission (allow/ask/deny)
 *     → stdout → Cursor uses it to allow/deny/ask
 *
 * Fail-closed: any uncaught error → deny. Never throws to Cursor.
 */

// Load API keys from a .env file before anything else. Cursor hooks run in a
// sandboxed env that doesn't inherit the user's shell vars.
//
// Search order (first match wins):
//   1. ~/.io-auto-mode/.env  (canonical — sits next to the user's config)
//   2. ~/io-data/.env        (legacy convention, kept for back-compat)
// If neither exists, keys must already be in process.env.
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
    break;
  } catch { /* try the next path */ }
}

import { classify } from "../../../core/classifier.js";
import { classifyMcpCall } from "../../../core/mcp.js";
import { serialiseTranscript } from "../../../core/transcript.js";
import { logDecision, setLogPath } from "../../../core/logger.js";
import { DEFAULT_CONFIG } from "../../../core/types.js";
import type {
  ClassifierConfig,
  ClassifierDecision,
  ConversationMessage,
  Decision,
} from "../../../core/types.js";
import { modelCall } from "./model-call.js";
import { readPrompt } from "./prompt-store.js";

interface CursorExecutionInput {
  command?: string;
  cwd?: string;
  sandbox?: boolean;
  conversation_id?: string;
  generation_id?: string;
  cursor_version?: string;
  workspace_roots?: string[];
  user_email?: string | null;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: string;
  mcp_server_name?: string;
}

interface CursorPermissionOutput {
  permission: "allow" | "deny" | "ask";
  user_message?: string;
  agent_message?: string;
}

function emit(output: CursorPermissionOutput): never {
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

function failClosed(reason: string): never {
  emit({
    permission: "deny",
    user_message: `io-auto-mode: ${reason}`,
    agent_message: `Blocked by io-auto-mode: ${reason}. Reword your task or escalate to the user.`,
  });
}

// Core's three-tier `Decision` ('allow' | 'ask' | 'block') maps to Cursor's
// `permission` ('allow' | 'ask' | 'deny'). Same semantics as Claude Code; we
// keep the mapping explicit so it's obvious at review time.
function mapDecision(d: Decision): "allow" | "ask" | "deny" {
  if (d === "allow") return "allow";
  if (d === "ask") return "ask";
  return "deny";
}

function reasonFrom(result: ClassifierDecision): string {
  const parts = [`stage=${result.stage}`];
  if (result.model) parts.push(`model=${result.model}`);
  parts.push(`${result.durationMs}ms`);
  if (result.reason) parts.push(result.reason);
  return parts.join(" · ");
}

function loadConfig(): ClassifierConfig {
  const candidates = [
    process.env.IO_AUTO_MODE_CONFIG,
    resolve(homedir(), ".io-auto-mode", "config.json"),
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function buildMessages(
  conversationId: string | undefined,
  action: string,
  toolName: string,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  // Cached user prompt (from beforeSubmitPrompt) — gives Stage 2 the same
  // conversation context that transcript_path provides on Claude Code.
  if (conversationId) {
    const cached = readPrompt(conversationId);
    if (cached?.prompt) {
      messages.push({ role: "user", content: cached.prompt, source: "direct" });
    }
  }

  // The action itself, framed as an assistant tool_use block so the
  // classifier knows what it's about to run. Mirrors how the Claude Code
  // adapter's transcript reader frames assistant tool_use entries.
  messages.push({
    role: "assistant",
    content: [{ type: "tool_use", name: toolName, input: action }],
  });

  return messages;
}

async function main() {
  setLogPath(resolve(homedir(), ".io-auto-mode", "auto-mode-log.jsonl"));

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    return failClosed(`failed to read stdin: ${err}`);
  }

  let input: CursorExecutionInput;
  try {
    input = JSON.parse(raw) as CursorExecutionInput;
  } catch (err) {
    return failClosed(`invalid hook JSON: ${err}`);
  }

  const isMcp = input.hook_event_name === "beforeMCPExecution" || Boolean(input.mcp_server_name);
  let canonicalMcpName: string | undefined;
  let mcpInput: Record<string, unknown> | undefined;
  let action: string;

  if (isMcp) {
    const server = input.mcp_server_name?.trim();
    const tool = input.tool_name?.trim();
    if (!server || !tool) return failClosed("MCP call is missing server or tool identity");
    canonicalMcpName = `mcp__${server}__${tool}`;
    try {
      const parsed: unknown = JSON.parse(input.tool_input ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return failClosed("MCP tool_input is not a JSON object");
      }
      mcpInput = parsed as Record<string, unknown>;
    } catch {
      return failClosed("MCP tool_input is not valid JSON");
    }
    action = canonicalMcpName;
  } else {
    action = input.command?.trim() ?? "";
    if (!action) return emit({ permission: "allow" });
  }

  const messages = buildMessages(
    input.conversation_id,
    action,
    canonicalMcpName ?? "Shell",
  );
  const transcript = serialiseTranscript(messages);
  const config = loadConfig();

  // sandbox=true means Cursor is running this in an isolated container; the
  // blast radius is contained, so we run as a non-main session (classifier
  // failure → block, which is reasonable when the user can't see an "ask"
  // prompt). sandbox=false means a real terminal — main session, ask is
  // surfaced to the user.
  const isMainSession = !input.sandbox;

  let result: ClassifierDecision;
  try {
    if (canonicalMcpName) {
      ({ action, result } = await classifyMcpCall({
        toolName: canonicalMcpName,
        toolInput: mcpInput,
        transcript,
        modelCall,
        config,
        isMainSession,
        source: "direct",
      }));
    } else {
      result = await classify(action, transcript, modelCall, config, {
        isMainSession,
        source: "direct",
      });
    }
  } catch (err) {
    return failClosed(`classifier threw: ${err}`);
  }

  try {
    logDecision(action, result, "direct", {
      adapter: "cursor",
      conversationId: input.conversation_id,
      cursorVersion: input.cursor_version,
      workspaceRoots: input.workspace_roots,
      userEmail: input.user_email ?? null,
    });
  } catch {
    // Log failure is non-fatal; continue with the decision.
  }

  const permission = mapDecision(result.decision);
  const reason = reasonFrom(result);

  if (permission === "allow") {
    return emit({ permission: "allow" });
  }
  if (permission === "ask") {
    return emit({
      permission: "ask",
      user_message: reason,
    });
  }
  // permission === "deny"
  return emit({
    permission: "deny",
    user_message: reason,
    agent_message: `Blocked by io-auto-mode: ${reason}. Reword your task or escalate to the user.`,
  });
}

// Resolve symlinks so the main-module check works when the file is invoked
// via an npm `bin` symlink (where process.argv[1] is the symlink path but
// import.meta.url resolves to the real target).
import { realpathSync as realpathSyncMain } from "node:fs";
let mainEntryReal: string;
try {
  mainEntryReal = realpathSyncMain(process.argv[1]);
} catch {
  mainEntryReal = process.argv[1];
}
const isMainModule = import.meta.url === `file://${mainEntryReal}`;
if (isMainModule) {
  main().catch((err) => failClosed(`unhandled: ${err}`));
}
