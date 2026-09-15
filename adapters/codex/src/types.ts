/**
 * io-auto-mode Codex adapter -- PreToolUse hook event types.
 *
 * Codex fires a PreToolUse command hook (wired via .codex/hooks.json) before
 * every tool call and delivers a snake_case JSON payload on stdin. The hook
 * emits a JSON response on stdout and always exits 0; a block is carried by
 * the response body, not the exit code (see CodexHookResponse below).
 *
 * These types mirror the live Codex wire format, verified against the
 * codex-rs source: `codex-rs/core/src/hook_runtime.rs` (PreToolUseRequest,
 * the stdin shape) and `codex-rs/hooks/src/engine/output_parser.rs` plus
 * `codex-rs/hooks/src/events/pre_tool_use.rs` (the response parser).
 */

/**
 * Tool input payload. Codex delivers this as an arbitrary JSON value; for the
 * Bash tool it carries `command` (verified: hook_runtime.rs reads
 * `tool_input.get("command")`). MCP tools use the same open-ended object.
 */
export interface CodexToolInput {
  command?: string;
  [key: string]: unknown;
}

/**
 * Full Codex PreToolUse hook request (snake_case JSON on stdin).
 * Mirrors PreToolUseRequest in codex-rs/core/src/hook_runtime.rs.
 */
export interface CodexPreToolUseRequest {
  session_id?: string;
  turn_id?: string;
  subagent?: unknown;
  cwd?: string;
  transcript_path?: string;
  model?: string;
  permission_mode?: string;
  tool_name?: string;
  matcher_aliases?: string[];
  tool_use_id?: string;
  tool_input?: CodexToolInput;
}

/**
 * PreToolUse hook response emitted on stdout.
 *
 * READ THIS BEFORE CHANGING THE SHAPE. The obvious-looking contract
 * (`permissionDecision:"allow"` + exit 2 to block) is WRONG. It matches the
 * `src/hooks/preToolUse.ts` JS SDK reference, which does not match the
 * runtime that actually parses this output. Against a real Codex the wrong
 * shape fails every invocation -- first with "hook returned invalid
 * pre-tool-use JSON output", then (after a partial fix) with "unsupported
 * permissionDecision:allow" -- which means the deny path silently never
 * blocks anything. The shape below is derived from the parser itself
 * (`codex-rs/hooks/src/engine/output_parser.rs` + `events/pre_tool_use.rs`).
 *
 * The real contract:
 *   - Exit code is ALWAYS 0. Exit 2 routes to a DIFFERENT codepath that reads
 *     stderr as a raw block reason and ignores stdout JSON entirely.
 *   - ALLOW is an EMPTY body ({}). Explicitly setting permissionDecision:
 *     "allow" without a paired updatedInput rewrite is itself rejected as
 *     unsupported -- a hook only exists to block; the absence of a decision
 *     IS the allow signal.
 *   - DENY needs hookSpecificOutput.permissionDecision:"deny" PLUS a
 *     non-empty permissionDecisionReason string (empty/missing is rejected).
 */
export interface CodexHookResponse {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "deny";
    permissionDecisionReason?: string;
  };
}
