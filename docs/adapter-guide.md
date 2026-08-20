# Writing an io-auto-mode adapter

So you want to wire io-auto-mode into a runtime that isn't already supported. This is the short tour. The shipped adapters (`claude-code`, `cursor`, `antigravity`, `codex`, `openclaw`) are the canonical worked examples — none of them is more than ~250 LOC of glue.

The headline: **`core/` does the classification work**. An adapter's job is just to get a tool-call event out of the runtime, hand it to the classifier in the right shape, and translate the decision back. No classifier logic lives in adapter code; if you're tempted to put any there, push it into `core/` first.

---

## What you're building

```
runtime tool-call event ──▶ adapter
                              │
                              ▼
            build ConversationMessage[]
                              │
                              ▼
                serialiseTranscript()       ◀── core/transcript.ts
                              │
                              ▼
                       classify()           ◀── core/classifier.ts
                              │
                              ▼
            map decision → runtime permission
                              │
                              ▼
                       logDecision()        ◀── core/logger.ts
                              │
                              ▼
                runtime allows/asks/denies the call
```

Five shipped adapters, five different runtime surfaces, same five steps.

---

## The five contracts

### 1. Receive the hook event

Whatever shape the runtime gives you. Shipped patterns:

- **Cursor + Claude Code:** child process per hook firing. Stdin is hook-event JSON, stdout is a permission JSON. See `adapters/cursor/src/hook.ts` and `adapters/claude-code/src/hook.ts`.
- **Antigravity (agy):** child process per `PreToolUse` firing, like Cursor/Claude Code, but the result contract is a bare boolean — stdin is agy hook JSON, stdout is exactly `{"allowTool": bool}`. The cleanest example of a binary runtime (no native "ask", so `ask` collapses to block) and of emitting a strict single-field result. See `adapters/antigravity/src/pretooluse-classify.ts`.
- **Codex:** child process per `PreToolUse` firing, stdin is snake_case request JSON. The result contract is *asymmetric*, and it is the best cautionary example in the repo: the exit code is **always 0**, allow is an **empty body** (`{}`), and deny is `hookSpecificOutput.permissionDecision: "deny"` plus a **non-empty** `permissionDecisionReason`. Emitting an explicit `"allow"` is rejected as unsupported, and exiting 2 routes to a different codepath that ignores stdout entirely. Read `adapters/codex/src/types.ts` before assuming any runtime's documented contract matches its parser. See `adapters/codex/src/pretooluse-hook.ts`.
- **OpenClaw:** long-lived plugin. Register a `before_tool_call` handler with the plugin API and accumulate transcripts in-process. See `adapters/openclaw/src/plugin.ts`.

If the runtime only gives you a one-shot stdin/stdout interface, you'll likely also want a side-channel cache for any context the runtime doesn't pass on each call — see "Optional: prompt cache" below.

Whichever pattern you're on, **load API keys before any imports that need them**. Hooks usually run in a sandboxed env that doesn't inherit the user's shell. The shipped adapters scan `~/.io-auto-mode/.env` then `~/io-data/.env` first thing in `hook.ts`.

### 2. Build the conversation context

The classifier needs the recent conversation as `ConversationMessage[]` (defined in `core/types.ts`). What goes in:

- The user prompt that led to this tool call (so prompt-injection text can't influence its own classification — see [Design principles](../README.md#design-principles))
- Any prior tool calls and their outputs in this turn
- The current tool call, framed as an `assistant` `tool_use` block

The shape is small:

```ts
interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | AssistantContentBlock[];
  source?: 'direct' | 'external' | 'agent';
  // ...
}
```

`source` matters. `'direct'` = user typed it. `'external'` = came from a tool result (PDF body, scraped page, MCP response — anywhere prompt injection can hide). `'agent'` = sub-agent output. The classifier weighs context differently per source.

Then call `serialiseTranscript()` (in `core/transcript.ts`) to convert your messages into `TranscriptEntry[]` — the shape `classify()` actually consumes.

### 3. Call the classifier

```ts
import { classify } from '../../../core/classifier.js';

const result = await classify(command, transcript, modelCall, config, {
  isMainSession,    // false in sub-agents / sandboxed exec — `ask` becomes `block`
  source: 'direct', // provenance of the *command* itself
});
```

`isMainSession` is the one that catches people. If the user can't see an `ask` prompt right now (sub-agent run, sandboxed background exec), pass `false` — the classifier will collapse `ask` → `block`, which is the right fail-closed choice. The Cursor adapter maps this from the hook payload's `sandbox` flag (`isMainSession = !sandbox`).

`config` is `ClassifierConfig` (model picks, mode, user pattern overrides). Read it from `~/.io-auto-mode/config.json` or your runtime's plugin config — see how each shipped adapter does `loadConfig()`.

### 4. Map the decision back

Core returns `'allow' | 'ask' | 'block'`. Your runtime probably has a similar shape with different vocabulary. Cursor uses `allow / ask / deny`; Claude Code uses `allow / ask / deny`; OpenClaw returns a result object. Keep the mapping in one tiny function so review is obvious:

```ts
function mapDecision(d: Decision): 'allow' | 'ask' | 'deny' {
  if (d === 'allow') return 'allow';
  if (d === 'ask') return 'ask';
  return 'deny';
}
```

**If the runtime only supports binary allow/deny on a given hook**, collapse `ask` → `deny` and surface the reason in the user-facing message. Cursor's `beforeReadFile` is the example — see `adapters/cursor/src/file-hook.ts` for the pattern.

### 5. Log + fail closed

```ts
logDecision(command, result, source, {
  adapter: 'my-runtime',
  conversationId: input.conversation_id,
  // ...any runtime-specific identity fields
});
```

The optional identity fields land in `auto-mode-log.jsonl` so audits can tell entries apart. The shape is `LogIdentity` in `core/types.ts` — extend it if your runtime exposes useful identity (workspace roots, user email, runtime version).

**Every error path returns `deny`.** `try/catch` around stdin parse, classifier call, log write — anything that can throw. Never let an exception leak through and produce no output, since "no decision" tends to be runtime-interpreted as "allow". The shipped adapters have a `failClosed()` helper at the top of `hook.ts` worth copying.

---

## Optional: file-zone classifier

For `Read` / `Write` / `Edit` tool calls, you don't want to burn an LLM call on every file touch. The pattern is a separate hook that does pure regex-based zone matching against `allowRead` / `allowWrite` / `deny` globs from `~/.io-auto-mode/config.json` + per-project `.io-auto-mode.json`.

Working implementation: `adapters/claude-code/src/file-hook.ts` and `adapters/cursor/src/file-hook.ts`. Both use the same merge logic (global + per-project, additive + deduped) and the same `realpathSync()`-then-glob-match flow. If your runtime has a file-read/write hook, copy one of those and adjust the dispatch.

The cursor file-hook also handles the dispatch case where one hook script handles two events (`beforeReadFile` and `preToolUse` Edit|Write) by routing on input shape — useful pattern if your runtime has the same.

---

## Optional: prompt cache

The classifier's prompt-injection guarantee depends on having the user prompt in context. Some runtimes (Cursor) don't pass the prompt to shell hooks — they only pass the prompt to a separate `beforeSubmitPrompt` hook. The fix: a small file-backed cache keyed by `conversation_id`, written by the prompt hook and read by the shell hook.

Shipped pattern: `adapters/cursor/src/prompt-store.ts`. ~30 lines, atomic-rename writes, best-effort reads, sanitised conversation IDs.

If your runtime *does* pass a transcript path or prompt directly into the shell hook (Claude Code), you can skip this — read the transcript file directly like `adapters/claude-code/src/read-transcript.ts` does.

---

## Provide a `ModelCallFn`

The classifier doesn't ship with a model client. You provide a function with this signature:

```ts
type ModelCallFn = (options: ModelCallOptions) => Promise<string>;
```

Both shipped TypeScript adapters use the same ~80 LOC `model-call.ts` that does provider-specific `fetch()` calls (Google Gemini, Anthropic, OpenAI). It's not in `core/` only because we plan to migrate to AI SDK and rip the duplicated code out — see `specs/ai-sdk-migration.md`. For now, copy `adapters/cursor/src/model-call.ts` and use it as-is.

OpenClaw's adapter does it differently: it gets API keys via the OpenClaw runtime's auth API rather than reading env vars. Follow whichever pattern fits your runtime's secrets story.

---

## Build + ship

If you're following the shipped TypeScript pattern:

1. **Bundle with esbuild.** `scripts/build.mjs` already wires up the cursor + claude-code adapters; add a target block for yours. The build emits a single self-contained ESM file with a `#!/usr/bin/env node` shebang and `chmod +x` applied.
2. **Add a `bin` entry in `package.json`** so users can install the adapter via `npm install -g io-auto-mode` and reference it by name in the runtime's hook config.
3. **Add the dist + prompts dirs to the `files` whitelist in `package.json`** so they ship in the npm package.
4. **Tests under `tests/`** using the Node built-in test runner (`tsx --test`). Cover at minimum: dispatch routing, decision mapping, ask-collapse if applicable, symlink-resolved isMainModule check.

---

## Pre-merge checklist

- [ ] Hook event(s) covered for the runtime's full surface (shell, file-read, file-write/edit at minimum)
- [ ] Every error path returns deny — stdin parse, JSON parse, classifier call, log write
- [ ] `logDecision()` called with `adapter:` identity field set
- [ ] `ask` → `deny` collapse anywhere the runtime hook only supports binary
- [ ] `isMainSession` mapped from whatever sandbox / sub-agent signal the runtime exposes
- [ ] `realpathSync(process.argv[1])` in the isMainModule guard if invoked via `bin` symlink
- [ ] Tests covering dispatch, decision mapping, and any runtime-specific quirks
- [ ] esbuild target added to `scripts/build.mjs` with shebang + `chmod +x`
- [ ] `bin` entry in `package.json` plus `files` whitelist updated for `dist/` + `prompts/`
- [ ] `INSTALL.md` section explaining how to wire the runtime's hook config
- [ ] Spec under `specs/<runtime>-adapter.md` if the integration has any non-obvious mappings (worth doing — see `specs/cursor-adapter.md` for the bar)

---

## Worked examples

- **Cursor adapter** — `adapters/cursor/` + `specs/cursor-adapter.md`. Most complete example: four hooks, prompt cache, ask-collapse, full identity logging.
- **Claude Code adapter** — `adapters/claude-code/`. Cleanest stdin/stdout example, transcript file mining, two hooks (Bash + file).
- **Antigravity adapter** — `adapters/antigravity/`. Smallest example: a single `PreToolUse` hook, a bare-boolean result contract (`{"allowTool": bool}`), `run_command`-only with read-only-tool passthrough, and `ask` → block collapse. Good starting point for a binary runtime.
- **Codex adapter** — `adapters/codex/`. Best example of an asymmetric result contract: allow is an empty body `{}`, deny is `hookSpecificOutput.permissionDecision: "deny"` with a mandatory non-empty reason, and the exit code is always 0 regardless. Also the only adapter that classifies a **patch** tool (`apply_patch`) alongside the shell tool, and the one that shows what to do when the model refuses on format grounds rather than on risk. Worth reading if your runtime's hook contract has an "absence means allow" shape.
- **OpenClaw adapter** — `adapters/openclaw/`. Plugin-API example, in-process transcript accumulation, runtime-managed secrets.

If you've got an adapter for a new runtime working end-to-end, open an issue or PR — happy to merge it in.
