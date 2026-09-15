# Cursor Adapter Spec

**Status:** spec, ready to execute
**Date:** 2026-04-29 (revised after researcher pass against cursor.com/docs/hooks)
**Owner:** Doctor Two (platform-side implementation)
**Goal:** Add a Cursor adapter alongside Claude Code and OpenClaw, so io-auto-mode protects Cursor's Agent tool-execution paths via Cursor's native hooks system, with prompt-injection-hardening parity with the Claude Code adapter.

---

## 0. Why now

Cursor was the runtime behind the most public agent-deletes-database incident referenced in the README backstory. Their hooks system gives a clean integration point that didn't exist when v0.1.0 was scoped. Adding Cursor extends the project from "Claude Code + OpenClaw" to "all three major agentic-dev runtimes" — the right surface for the launch narrative.

Reference: <https://cursor.com/docs/hooks>

---

## 1. Cursor hook surface

| Cursor hook | Fires on | In scope | Maps to |
|---|---|---|---|
| `beforeSubmitPrompt` | User hits send, before backend request | ✓ | Capture user prompt for next-call context |
| `beforeShellExecution` | Agent shell command, pre-exec | ✓ | Bash classifier |
| `beforeReadFile` | Agent file read, pre-exec | ✓ | File-hook (Read) |
| `preToolUse` (matched on Edit/Write only) | Agent file write/edit, pre-exec | ✓ | File-hook (Write/Edit) |
| `beforeMCPExecution` | Agent MCP tool call, pre-exec | ✓ | Shared MCP classifier; parses JSON-stringified `tool_input` |
| `beforeTabFileRead` | Tab inline-completion file read | ✗ | File-hook (Read) — also allow/deny only, no ask |
| `afterFileEdit` | Agent file edit, post-hoc | ✗ | Audit only — too late to prevent |
| `subagentStart` / `subagentStop` | Subagent lifecycle | ✗ | Audit-only; not core to permission classification |
| `stop` / `sessionStart` / `sessionEnd` | Lifecycle | ✗ | Nothing for the classifier to do |

**Important: `beforeReadFile` and `beforeTabFileRead` only support `permission: "allow" | "deny"`.** They do **not** accept `ask`. Our adapter must collapse core's `ask` → `deny` (with the reason in `user_message`) for any file-read hook. This matches the project's fail-closed posture.

---

## 2. Architecture

Mirrors the Claude Code adapter, with one new piece: a small prompt-cache to bridge `beforeSubmitPrompt` → next `beforeShellExecution`.

Four files in `adapters/cursor/src/`:

- `hook.ts` — `beforeShellExecution` handler. Reads stdin, loads the cached user prompt for this `conversation_id` (if present), builds a `TranscriptEntry`-shaped context, runs `core/classifier.classify()`, maps decision to Cursor's `{permission, user_message, agent_message}` JSON.
- `file-hook.ts` — handles both `beforeReadFile` and `preToolUse` (matched on Edit/Write). Path-based zone classifier; same shape as Claude Code's `file-hook.ts`. Tool-name routing (Read → `allowRead`; Edit/Write → `allowWrite`). Collapses `ask` → `deny` for `beforeReadFile` since Cursor's schema doesn't accept `ask` there.
- `prompt-store.ts` — write/read user prompts keyed by `conversation_id`. Atomic-rename writes; best-effort reads. See §3 prompt-cache design below.
- `prompt-hook.ts` — `beforeSubmitPrompt` handler. Calls `prompt-store.write(conversation_id, prompt)`. Always `permission: allow` (this hook never blocks; its only job is to capture context).

Three bin wrappers in `adapters/cursor/bin/`:

- `classify-shell.sh` — invokes `dist/hook.js`.
- `classify-file.sh` — invokes `dist/file-hook.js`.
- `capture-prompt.sh` — invokes `dist/prompt-hook.js`.

All follow the same shape as the Claude Code adapter's wrappers: derive `CURSOR_HOOK_ROOT` from `BASH_SOURCE`; prefer bundled output; fall back to source via `tsx`.

**Code reuse:** zero changes to `core/`. Adapter is purely glue plus the new prompt-cache.

---

## 3. Schema mappings

### `beforeSubmitPrompt` → prompt cache

Cursor input:
```json
{
  "conversation_id": "string",
  "generation_id": "string",
  "model": "string",
  "hook_event_name": "beforeSubmitPrompt",
  "cursor_version": "string",
  "workspace_roots": ["<path>"],
  "user_email": "string | null",
  "transcript_path": "string | null",
  "prompt": "<user message body>",
  "attachments": [{"type": "file | rule", "file_path": "<absolute path>"}]
}
```

Adapter:
1. Persist the user prompt + attachments to `~/.io-auto-mode/cache/cursor-prompts/<conversation_id>.json` via atomic write (write to `<file>.tmp`, then `rename` → `<file>.json`).
2. Return `{permission: "allow"}` — this hook never blocks the user.
3. Log a tiny entry to `auto-mode-log.jsonl` with `{type: "prompt-capture", conversation_id, durationMs}` so the audit trail shows context was captured.

### `beforeShellExecution` → core classifier

Cursor input:
```json
{
  "command": "<full terminal command>",
  "cwd": "<current working directory>",
  "sandbox": false,
  "conversation_id": "string",
  "user_email": "string | null",
  "workspace_roots": ["<path>"],
  "cursor_version": "string"
}
```

Adapter:
1. Read cached prompt (if any) for `conversation_id` from `prompt-store`.
2. Build `TranscriptEntry[]` with two entries: the cached user prompt (role: `user`, source: `direct`), and the current `command` as a tool-use entry. If no cached prompt, build with just the command (degraded; same behaviour as Claude Code without `transcript_path`).
3. Call `classify(command, transcript, modelCall, config, { isMainSession: !sandbox })`.

**Why `isMainSession: !sandbox`:** Cursor's `sandbox` field indicates the command is running in a containerised, isolated environment where blast radius is contained. In core's terminology, `isMainSession: true` means the user is present at a real terminal — fail-closed leaning toward `ask` is appropriate. When `sandbox: true`, the same risk is mitigated by the sandbox itself, so we let core run with `isMainSession: false` (fall-through to `block` rather than `ask` on classifier failure, since asking when the user can't see the prompt is worse than blocking and forcing a retry).

Output mapping:

| `core` decision | Cursor `permission` | `user_message` | `agent_message` |
|---|---|---|---|
| `allow` | `allow` | (omitted) | (omitted) |
| `block` | `deny` | `<reason from core>` | `Blocked by io-auto-mode: <reason>. Reword your task or escalate to the user.` |
| `ask` | `ask` | `<reason from core>` | (omitted — Cursor surfaces ask to the user, not the agent) |

### `beforeMCPExecution` → shared MCP classifier

Shipped for local IDE Agent runs. The adapter requires `mcp_server_name` and
`tool_name`, parses the JSON-stringified `tool_input`, normalises the identity
to `mcp__server__tool`, applies canonical-name policy and redacts credentials.
Malformed input or classifier infrastructure failure returns `deny`.

### `beforeReadFile` → file-hook

Cursor input:
```json
{
  "file_path": "<absolute path>",
  "content": "<file contents>",
  "attachments": [{"type": "file | rule", "file_path": "<absolute path>"}],
  "conversation_id": "string",
  "user_email": "string | null"
}
```

Adapter:
1. Map to file-hook with `tool_name = "Read"`.
2. **Collapse `ask` → `deny`** — Cursor's `beforeReadFile` schema is `allow | deny` only, no `ask`. If file-hook would have returned `ask`, the adapter returns `deny` with the reason in `user_message`. This matches the fail-closed posture; user can override the deny by adding the path to their `allowRead` zone in `~/.io-auto-mode/config.json`.
3. Ignore `content` and `attachments` for v0.1.x (path-based decisions only).

Output: `{permission: "allow" | "deny", user_message: "<reason if denied>"}`.

### `preToolUse` (Edit/Write only) → file-hook

Cursor input:
```json
{
  "tool_name": "Edit | Write",
  "tool_input": {"file_path": "/abs/path", ...},
  "tool_use_id": "abc123",
  "cwd": "/project",
  "conversation_id": "string"
}
```

**Matcher rationale (do not widen):** the hook config sets `matcher: "Edit|Write"` because:
- `Read` is already handled by `beforeReadFile`
- `Shell` is already handled by `beforeShellExecution`
- `Task` (Cursor's subagent tool) is out of scope (see §11)
- MCP tools are handled by `beforeMCPExecution` and normalised to `mcp__server__tool`
- Any other tool name we don't recognise allow-throughs at the adapter (returns `permission: allow` silently)

Widening the matcher to `*` or omitting it would create double-classification with the more specific hooks. Future contributors should add new tool-name mappings here, not widen the matcher.

Adapter: match on `tool_name ∈ {Edit, Write}`; if matched, run file-hook with `tool_name = "Write"` (Edit and Write share the `allowWrite` zone). Use `cwd` for `${projectDir}` expansion.

Output: same shape as `beforeShellExecution` (allow/deny/ask all valid for `preToolUse`).

### Identity fields → audit log

Every Cursor hook payload includes `conversation_id`, `generation_id`, `cursor_version`, `workspace_roots`, and (when logged-in) `user_email`. Add all five to each `auto-mode-log.jsonl` entry the adapter writes — they're a strict superset of what the Claude Code adapter logs today and provide better identity attribution for security audits without any extra work.

The logger (`core/logger.ts`) currently writes a flat object; the adapter just merges these fields into the log entry before write. Zero changes to core.

---

## 4. Configuration (user-facing)

User adds to `~/.cursor/hooks.json` (user-level) or `<project>/.cursor/hooks.json` (project-level):

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "<repo-path>/adapters/cursor/bin/capture-prompt.sh",
        "timeout": 1,
        "failClosed": false
      }
    ],
    "beforeShellExecution": [
      {
        "command": "<repo-path>/adapters/cursor/bin/classify-shell.sh",
        "timeout": 8,
        "failClosed": true
      }
    ],
    "beforeReadFile": [
      {
        "command": "<repo-path>/adapters/cursor/bin/classify-file.sh",
        "timeout": 2,
        "failClosed": false
      }
    ],
    "preToolUse": [
      {
        "_comment": "Edit|Write only — Read is handled by beforeReadFile, Shell by beforeShellExecution. Do not widen.",
        "command": "<repo-path>/adapters/cursor/bin/classify-file.sh",
        "matcher": "Edit|Write",
        "timeout": 2,
        "failClosed": false
      }
    ]
  }
}
```

`failClosed: true` for shell because that's the high-stakes path. The file classifier and prompt-capture are fail-open (parity with the Claude Code adapter, and the prompt-capture has no security implications if it fails).

API keys live in `~/.io-auto-mode/.env` (same convention as the Claude Code adapter).

### Prompt cache layout

```
~/.io-auto-mode/
├── .env                     # user's API keys
├── config.json              # zone config
├── auto-mode-log.jsonl      # decision log
└── cache/
    └── cursor-prompts/
        └── <conversation_id>.json   # latest user prompt per conversation
```

Cache files are small (~1-10KB each). v0.1.x has no automatic cleanup; users can `rm -rf ~/.io-auto-mode/cache/` if it grows. Backlog item: TTL-based cleanup (lazy, on-write) once we have data on size growth.

---

## 5. Build pipeline

Extend `scripts/build.mjs` with a `cursor` target. Three `esbuild.build()` calls mirroring the Claude Code adapter:

- `adapters/cursor/src/hook.ts` → `adapters/cursor/dist/hook.js`
- `adapters/cursor/src/file-hook.ts` → `adapters/cursor/dist/file-hook.js`
- `adapters/cursor/src/prompt-hook.ts` → `adapters/cursor/dist/prompt-hook.js`

`prompt-store.ts` is a shared module imported by both `hook.ts` and `prompt-hook.ts`; it gets bundled into both outputs (esbuild handles this transparently).

Output paths get `adapters/cursor/dist/` added to `.gitignore` (same pattern as the Claude Code adapter's `dist/`).

---

## 6. Tests

`tests/cursor-hook.test.ts` — pure schema-mapping + cache tests:

- **`beforeSubmitPrompt` parsing** — JSON in → cache file written with correct path + content.
- **Prompt cache write+read round-trip** — atomic-rename works, missing-file degrades gracefully, malformed cache file degrades gracefully.
- **`beforeShellExecution` parsing** — JSON in → core args (with cached prompt loaded if present).
- **`beforeReadFile` parsing** — JSON in → file-hook args.
- **`preToolUse` routing** — `tool_name ∈ {Edit, Write}` hits file-hook; `tool_name = Task` allow-throughs silently; missing `tool_name` allow-throughs.
- **Output mapping (shell + preToolUse):** core `allow|block|ask` → Cursor `{permission, user_message, agent_message}`.
- **Output mapping (beforeReadFile):** core `ask` collapses to Cursor `deny` (must-fix #1).
- **Sandbox flag:** `sandbox: true` propagates to `isMainSession: false`; `sandbox: false` to `isMainSession: true`.
- **Identity fields in log:** when adapter writes a log entry, `conversation_id`, `cursor_version`, `workspace_roots`, `user_email` are present.

Target: ~50-70 test cases. Picked up automatically by the existing `tsx --test tests/*.test.ts` glob.

---

## 7. INSTALL.md updates

Add `## Cursor` section between `## Claude Code` and `## OpenClaw`. Mirror the Claude Code section structure:

1. **Step 1: Clone, install, build** (same as Claude Code).
2. **Step 2: Provide your API key** (same `~/.io-auto-mode/.env`).
3. **Step 3: Wire the four hooks into `~/.cursor/hooks.json`** (full snippet from §4 above; emphasise that all four are needed for full coverage — `beforeSubmitPrompt` is what gives Stage 2 conversation context for prompt-injection hardening).
4. **Step 4: Restart Cursor** (note hot-reload behaviour — verify during smoke test, document the truthful path).
5. **Step 5: Verify** (`tail -f ~/.io-auto-mode/auto-mode-log.jsonl`, run a test command, see entries land with `conversation_id` populated).
6. **Optional: Tab hook setup** (forward-reference to a v0.2 follow-up; note that Tab hooks don't support `ask`, same constraint as `beforeReadFile`).

---

## 8. README updates

- File tree: add `adapters/cursor/   Cursor hooks adapter (Agent: prompt + shell + file)`.
- Add `## Quick start (Cursor)` sibling to OpenClaw + Claude Code quick starts.
- Roadmap: change `[ ] Cursor adapter` → `[x] Cursor adapter (beforeSubmitPrompt + beforeShellExecution + beforeReadFile + preToolUse)`.
- "How it works" section: add a one-liner noting that on Cursor, `beforeSubmitPrompt` provides the conversation context that `transcript_path` provides on Claude Code. Same prompt-injection-hardening guarantee, different mechanism.
- Tagline / repo description: re-include "Cursor" once the adapter ships.

---

## 9. Implementation phases

| Phase | Scope | Est. |
|---|---|---|
| 1 | `adapters/cursor/src/{hook,file-hook,prompt-hook,prompt-store}.ts` — TypeScript src + bin wrappers | 1.5h |
| 2 | Build pipeline integration (`scripts/build.mjs` + `.gitignore`) | 15m |
| 3 | `tests/cursor-hook.test.ts` — schema + cache tests (~50-70 cases) | 45m |
| 4 | INSTALL.md `## Cursor` section + README updates + roadmap tick | 30m |
| 5 | Manual smoke test in real Cursor session including hot-reload check; document truthful behaviour | 30m |

**Total:** ~3.5 hours.

Three commits:
1. `feat(cursor): adapter src + bin wrappers + prompt store` (phase 1)
2. `feat(cursor): build pipeline + tests` (phases 2-3)
3. `docs(cursor): INSTALL section + README updates` (phase 4); smoke test (phase 5) lands in this commit too if findings are documentation-only, otherwise filed as a follow-up.

---

## 10. Acceptance criteria

- A Cursor user can copy the hooks.json snippet from INSTALL.md, restart Cursor, and have classifier decisions appear in `~/.io-auto-mode/auto-mode-log.jsonl` with `conversation_id` populated.
- `beforeSubmitPrompt` writes to `~/.io-auto-mode/cache/cursor-prompts/<conversation_id>.json` and `beforeShellExecution` reads it back; Stage 2 sees the user prompt as context.
- `beforeReadFile` correctly collapses `ask` → `deny` (verifiable by setting up a zone that triggers ask on the file-hook side and watching Cursor get a `deny`).
- `pnpm test` passes including new cursor-hook tests.
- `pnpm typecheck` clean.
- Zero new runtime dependencies; same `core/` classifier, same `~/.io-auto-mode/config.json` zone config.
- **Hot-reload behaviour smoke-tested**: change `hooks.json`, observe whether next agent action picks up new hooks without restart. Document truthful answer in INSTALL.md (researcher flagged this as a wildcard time-sink).
- Smoke-tested in at least one real Cursor session, OR a TODO is filed in `BACKLOG.md` with reproduction steps.

---

## 11. Out of scope (deferred)

- **`updated_input` rewriting on `preToolUse`** — Cursor's hook can rewrite the tool input pre-execution (e.g. redact secrets from a file write before it lands). Out of scope for v0.1.x but worth tracking; could be a future security feature ("auto-redact `.env` content from any Write tool call").
- **`beforeTabFileRead` / `afterTabFileEdit`** — Tab is autonomous inline completion. Arguably *higher* stakes than Agent (no human in the loop, fires per-keystroke), but doubles the integration surface. `beforeTabFileRead` also has the `allow|deny`-only constraint (no `ask`). Worth a follow-up once we have user feedback on whether Tab coverage is a real ask, and whether the classifier latency budget can absorb that frequency.
- **`subagentStart` / `subagentStop`** — interesting for "audit which subagents fire" but not core to permission classification.
- **`stop` / `sessionStart` / `sessionEnd`** — lifecycle hooks; nothing for a permission classifier to do here.
- **Enterprise-distributed configs** — Cursor supports MDM-distributed `hooks.json` at OS-level paths. Out of scope for OSS v0.1.x; relevant if someone deploys io-auto-mode across a fleet.
- **Prompt-cache TTL cleanup** — cache files accumulate forever in v0.1.x. BACKLOG entry for lazy on-write TTL once we have growth data.

---

## 12. Open questions

1. **Hot-reload vs restart.** Cursor's docs imply hooks.json changes might require restart, but it's not explicit. Test both flows during smoke test and document truthfully. Update INSTALL accordingly.
2. **`transcript_path` availability.** Cursor only sets this if transcript logging is enabled. With `beforeSubmitPrompt` capturing the user prompt anyway, `transcript_path` becomes a nice-to-have (would give us the full back-and-forth) rather than a must. Document as "if available, used for richer context; if not, prompt cache is sufficient".
3. **`failClosed: true` semantics.** Cursor's docs say `failClosed: true` blocks the action on hook failure. Our `core/classifier.ts` already fails closed on every error path. The Cursor `failClosed` is a belt-and-braces guard for genuine hook-runtime failures (Node crashes, missing dist, etc.). Verify the interaction during smoke test.
4. **Loop limit.** Cursor's `loop_limit` (default 5) caps how many times an agent can retry after a denial. For Stage 2 ASK, we'd want this set sensibly so the agent doesn't burn through the budget on a single ambiguous command. Default may be fine; revisit after live use.
5. **Multi-conversation prompt cache.** If a user has many Cursor conversations open in parallel, the cache will have one file per `conversation_id`. Reads are O(1) (direct path lookup), writes are atomic per-file, no contention. Should scale fine; revisit if anyone hits issues.
