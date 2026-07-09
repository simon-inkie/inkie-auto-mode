# io-auto-mode

> A hybrid static + LLM exec security classifier for AI coding agents.
> Stops prompt injection and accidental destruction without making automation impossible.

**Status:** early (`v0.1.0`). OpenClaw, Claude Code, Cursor, and Antigravity (agy) adapters all shipping. Claude Code adapter has been in production use for ~2 weeks; Cursor and agy adapters are fresh. Tier 1 tests cover static patterns + file-hook zone matching + Cursor schema mappings (190 tests); full pipeline + transcript tests on the next tier. Looking for feedback from people running agentic dev workflows.

---

> ## ⚠️ Important — please read
>
> **This is a security product. Read the source before you trust it with real
> systems.** It runs in your tool-call hot path. Bugs, misconfigurations,
> prompt-injection of the classifier itself, model outages — any of these can
> let through commands that delete data, ship code, or move money.
>
> By using `io-auto-mode` you accept that:
>
> - It is provided **as-is**, no warranty, no fitness-for-purpose guarantee
>   (per the [MIT licence](./LICENSE))
> - You are responsible for understanding what it does and reviewing the
>   classifier rules + zone config for your environment before relying on it
> - The author(s) accept **no liability** for damage arising from bugs,
>   misconfiguration, model failures, or any other cause
> - This is **not** a substitute for backups, version control, real
>   least-privilege OS sandboxing, code review, or a human in the loop on
>   high-stakes actions
>
> Treat it as a layer in defence-in-depth, not the only layer.

---

## The problem

Permissioning for AI coding agents is currently binary:

- **Prompt for everything** — annoying, breaks any kind of automation
- **Allow everything** — yolo mode; one prompt-injection or one misread instruction and you've lost a database

There's no middle path. Static allow / deny lists can't capture the thing that actually matters: **a `git commit` during a coding task is expected; the same command while summarising a PDF is suspicious.** The risk is contextual.

`io-auto-mode` is a permission classifier that evaluates every shell-tool / file-tool call **with the conversation context** before it runs.

---

## How it works

Three layers, fail-closed:

```
Agent requests tool call
        │
        ▼
┌─── Static Pattern Layer (sub-ms) ───────────────┐
│  Hard-coded dangerous regex → BLOCK             │
│  Hard-coded safe regex      → ALLOW             │
│  Otherwise                  → fall through      │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─── Stage 1 — Fast LLM (~1s p50) ────────────────┐
│  Gemini Flash, plain text output                │
│  Biased toward blocking                         │
│  ALLOW → proceed                                │
│  BLOCK → escalate to Stage 2                    │
└────────────────────┬────────────────────────────┘
                     │ (only on BLOCK)
                     ▼
┌─── Stage 2 — Thinking LLM (~5s p50, blocks only)┐
│  Gemini w/ thinking, JSON output                │
│  Chain-of-thought reasoning                     │
│  Final decision + reason                        │
└─────────────────────────────────────────────────┘
```

Plus a separate path-based classifier for `Read` / `Write` / `Edit` tool calls — pure regex, no LLM, sub-millisecond.

### Design principles

- **Fail closed.** Every error case (API failure, parse failure, timeout) returns BLOCK. Never fail open.
- **Context-aware.** The classifier sees the conversation history. Same command, different risk depending on source and task.
- **Prompt-injection hardened.** Assistant text is excluded from classifier input — only user turns and tool_use blocks. The model can't craft text that influences its own classification.
- **Symlink-resolved.** Paths are resolved through `realpathSync()` before pattern-matching, so an attacker can't escape an `allowWrite` zone via a symlink to a credential file.
- **Fast by default.** Static layer at sub-millisecond, Stage 2 only runs on blocks. The happy path is cheap.
- **Tamper-resistant.** Dangerous-pattern lists are compiled into code, not loaded from editable files at runtime.
- **Transparent.** Blocked actions surface a clear reason; allowed actions are silent.
- **Zero runtime dependencies.** Core has none. Both shipped adapters bundle into single self-contained ESM files via esbuild. The OpenClaw adapter pulls in `openclaw` as an optional peer — install only if you use that runtime. `npm install -g io-auto-mode` adds one package, ~400KB on disk. Nothing else can deprecate, break, or get supply-chain-attacked under us.

---

## Live performance

Pulled from `~/.io-auto-mode/auto-mode-log.jsonl` over ~3,000 real classifications across our agents:

| Stage | n | p50 | p90 | avg |
|---|---:|---:|---:|---:|
| Static | 792 | 0ms | 0ms | 0ms |
| Stage 1 (Gemini Flash) | 951 | 799ms | 1216ms | 934ms |
| Stage 2 (Gemini Flash w/ thinking, blocks only) | 1018 | 4533ms | 6583ms | 4725ms |
| Fallback (one-shot retry) | 235 | 1509ms | 2355ms | 1734ms |

**Caveat:** these were measured over a flaky home wifi connection — your numbers on a stable link will be lower, especially Stage 2.

The headline takeaway is the **shape**, not the absolute numbers: ~80% of decisions resolve at the static layer at 0ms; everything else pays a sub-second LLM cost; Stage 2 only fires on blocks. The happy path is cheap.

---

## Cost

At Gemini 2.5 Flash pricing (~$0.30/M input tokens, ~$2.50/M output tokens), a casual session of ~50 tool calls/day costs single-digit pence. A heavy agentic-dev day (300+ tool calls) sits around 20-50p. Most of that is Stage 2 thinking output, which only fires on blocks — so the bill scales with how often the classifier *escalates*, not how often the agent runs commands.

Static-layer hits (~30% of all calls in our usage) are free. Stage 1 is one short LLM call per agent action; Stage 2 is rarer + slightly chunkier. You can swap any stage to a local LLM via config if you want zero cost — see [`specs/ai-sdk-migration.md`](./specs/ai-sdk-migration.md) for the planned Ollama / LM Studio path.

---

## What's in the repo

```
core/                      Shared classifier logic — no platform deps
  classifier.ts            Hybrid static + LLM pipeline
  static-patterns.ts       Hard-coded regex layer
  transcript.ts            Conversation context extraction
adapters/
  openclaw/                OpenClaw plugin (reference impl)
  claude-code/             Claude Code PreToolUse hooks (Bash + file)
  cursor/                  Cursor hooks (prompt + shell + file + write/edit)
  antigravity/             Antigravity (agy) PreToolUse classifier hook
specs/                     Future-work design specs (AI SDK migration, ...)
docs/                      Contributor docs — adapter guide etc.
tests/                     Tier 1 tests — static patterns + file-hook zones + cursor/agy mappings
INSTALL.md                 Install + config guide for all adapters
```

Small, focused codebase. Core has no runtime deps. The OpenClaw adapter pulls in `openclaw`; the Claude Code adapter is dep-free.

---

## Quick start (OpenClaw)

See [`INSTALL.md`](./INSTALL.md) for the full guide. TL;DR:

```bash
# 1. Register a Gemini key (used by all stages by default)
openclaw models auth login --provider google --method gemini-api-key

# 2. Add to openclaw.json
openclaw config patch '{"plugins":{"load":{"paths":["/path/to/io-auto-mode"]},"entries":{"io-auto-mode":{"enabled":true,"config":{"mode":"classify"}}}}}'

# 3. Restart
openclaw gateway restart

# 4. Watch decisions land
tail -f ~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

### Modes

| Mode | Behaviour |
|---|---|
| `classify` (default) | Run the three-layer pipeline |
| `yolo` | Allow everything (development / debugging) |
| `strict` | Block everything not on the static allowlist |

---

## Quick start (Claude Code)

See [`INSTALL.md`](./INSTALL.md) for the full guide. TL;DR:

```bash
# 1. Clone + install + build the adapter
git clone https://github.com/simon-inkie/io-auto-mode.git
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hooks can read it
mkdir -p ~/.io-auto-mode
echo 'GEMINI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

# 3. Wire the two PreToolUse hooks into ~/.claude/settings.json
#    (full snippet in INSTALL.md — Bash matcher + Read|Write|Edit matcher)

# 4. Restart your Claude Code session, then watch decisions land
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

Two hooks register: a Bash classifier (LLM-backed, fail-closed) and a path-based file classifier (pure regex, sub-millisecond).

---

## Quick start (Cursor)

See [`INSTALL.md`](./INSTALL.md) for the full guide. TL;DR:

```bash
# 1. Clone + install + build the adapter
git clone https://github.com/simon-inkie/io-auto-mode.git
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hooks can read it
mkdir -p ~/.io-auto-mode
echo 'GEMINI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

# 3. Wire four hooks into ~/.cursor/hooks.json
#    (full snippet in INSTALL.md — beforeSubmitPrompt, beforeShellExecution,
#     beforeReadFile, preToolUse with matcher Edit|Write)

# 4. Restart Cursor, then watch decisions land
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

Four hooks total: a Bash classifier (`beforeShellExecution`), a file classifier (`beforeReadFile` + `preToolUse` Edit|Write), and a prompt-capture (`beforeSubmitPrompt`) that gives Stage 2 conversation context for prompt-injection hardening -- same guarantee as Claude Code, different mechanism.

---

## Quick start (Antigravity / agy)

[Antigravity](https://antigravity.dev) (CLI: `agy`) is the non-Anthropic generalist runtime on the team. Its `PreToolUse` hook fires before every tool call; the adapter gates `run_command` through the same three-layer classifier as the Claude Code and Cursor adapters.

**Contract:** the agy hook adapter reads camelCase JSON on **stdin** and emits `{"allowTool": bool}` on **stdout**, exiting 0 on every path (fail-open). `run_command` calls are classified; read-only tools (`view_file`, `list_dir`, `grep_search`, etc.) are always allowed without a classify call.

```bash
# 1. Clone + install + build the adapter
git clone https://github.com/simon-inkie/io-auto-mode.git
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hook can read it
mkdir -p ~/.io-auto-mode
echo 'GEMINI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

# 3. Wire the PreToolUse hook into your agent's .agents/hooks.json
#    Replace <repo-path> with the absolute path you cloned to.
```

```json
{
  "your-agent-name": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/antigravity/bin/pretooluse-classify.sh"
          }
        ]
      }
    ]
  }
}
```

A ready-to-edit template lives at `adapters/antigravity/hooks/hooks.json`.

Shares the same core classifier, `~/.io-auto-mode/config.json` config, and `~/.io-auto-mode/.env` API keys as the Claude Code and Cursor adapters -- one config to maintain across all runtimes.

**What it catches (illustrative):**

- `rm -rf ~/project`, dropping a prod table, piping an untrusted `curl` into a shell -> **blocked** (destructive / irreversible).
- `git push --force` to a shared branch -> **blocked or flagged**, depending on your config.
- `cat README.md`, `npm test`, `ls -la`, scoped builds -> **allowed**.

Exact verdicts come from your `config.json` plus the LLM stage, so they adapt to context rather than a fixed denylist.

**Scope (v1):** the agy adapter gates `run_command` -- the shell surface that skip-permissions mode opens up. File read/write zone classification under agy (as the Claude Code and Cursor adapters do via their file hooks) is on the roadmap; until then, file tools pass through.

---

## Configuration

All options under `plugins.entries.io-auto-mode.config`:

| Option | Default | Description |
|---|---|---|
| `mode` | `classify` | `classify` / `yolo` / `strict` |
| `stage1Model` | `google/gemini-3.1-flash-lite` | Fast LLM for Stage 1 |
| `stage1Fallback` | `google/gemini-3.1-flash-lite` | Stage 1 fallback |
| `stage2Model` | `google/gemini-2.5-flash` | Thinking LLM for Stage 2 |
| `stage2Fallback` | `google/gemini-2.5-flash` | Stage 2 fallback |
| `userAllowPatterns` | `[]` | Extra regex patterns always allowed |
| `userBlockPatterns` | `[]` | Extra regex patterns always blocked |

Defaults are all-Gemini for cost + latency. Any provider OpenClaw supports
(Anthropic, OpenAI, etc.) can be swapped in by changing the model strings —
see [`specs/ai-sdk-migration.md`](./specs/ai-sdk-migration.md) for the planned
migration to AI SDK that makes this even smoother (Ollama / LM Studio /
self-hosted included).

For the `Read` / `Write` / `Edit` file-tool classifier, configure `fileZones` (allowRead / allowWrite / deny) in either user-global (`~/.io-auto-mode/config.json`) or per-project (`<project>/.io-auto-mode.json`). Layers merge.

---

## Decision log

Every classification is logged with timestamp, command, stage (static / stage1 / stage2 / error), decision, duration, model used, and chain-of-thought reasoning where applicable:

```
~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

Useful both for debugging surprising blocks and for reviewing what your agent has been up to.

---

## Status & roadmap

- [x] OpenClaw adapter (Bash classifier, file-tool classifier)
- [x] Per-project config overlays
- [x] Static-layer hardening (top-level critical-dir rule, mid-path glob matching)
- [x] Claude Code adapter (PreToolUse hooks; in production ~2 weeks)
- [x] Cursor adapter (`beforeSubmitPrompt` + `beforeShellExecution` + `beforeReadFile` + `preToolUse`; prompt-injection-hardening parity with Claude Code)
- [x] Antigravity (agy) adapter (`PreToolUse` matcher:* -- `run_command` classifier, read-only-tool passthrough, fail-open)
- [x] Tier 1 tests -- static patterns + file-hook zone matching + Cursor schema mappings + agy classifier (tsx --test)
- [x] CI -- GitHub Actions running typecheck + tests on every push / PR
- [ ] Tier 2 tests — full classifier pipeline (mocked LLM) + transcript prompt-injection coverage
- [ ] MCP tool classifier — server/tool-name matching
- [ ] AI SDK migration — provider-agnostic model calls ([spec](./specs/ai-sdk-migration.md))

See [`BACKLOG.md`](./BACKLOG.md) for more.

---

## Why I built it

I started this project because I wanted to give my OpenClaw agent **Io**
full autonomy without sleepless nights wondering if it was halfway through
`rm -rf` on my home directory, force-pushing to `main`, or quietly trashing
a production database because some PDF it was summarising contained an
instruction it took too literally.

The risk isn't theoretical. Recently a Cursor coding agent — running on
Claude — [wiped a company's database in nine seconds. The backups went with
it.](https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-powered-ai-coding-agent-deletes-entire-company-database-in-9-seconds-backups-zapped-after-cursor-tool-powered-by-anthropics-claude-goes-rogue)
I'd been designing for exactly that failure mode for months — the news just
confirms why a permission classifier with teeth has to exist before agents
are trusted with real systems.

The "ask before everything" mode kills automation. "Allow everything" mode
puts your data one prompt-injection away from gone. There was no middle path
that understood **context** — that the same `git push` is fine during a
coding task and suspicious during a PDF summary. So I built one.

Anthropic shipped [their own auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)
shortly after I started this. Theirs is a great default for individual
Claude Code users on Sonnet. Where io-auto-mode is shaped differently:

- **Rules over prompts.** Patterns and file zones are declarative JSON +
  regex. Diffable, code-reviewable, version-controlled — same shape as any
  other ops config. We ship our rules through CI alongside the code they
  protect, which is how the team and our agents share write access to the
  same systems without sleepless nights.
- **Multi-platform.** Runs in front of OpenClaw (chat-platform agents) and
  Claude Code, not just one runtime.
- **Provider-flexible.** Pick your model per stage — Gemini Flash for the
  hot path, Anthropic / OpenAI / a local LLM for thinking. AI SDK migration
  ([spec](./specs/ai-sdk-migration.md)) makes Ollama / LM Studio first-class,
  which matters for cost and privacy.
- **File-op classifier.** Separate path-based allow / deny / write zones for
  `Read` / `Write` / `Edit` tool calls — useful for stopping an agent
  reading `~/.aws/credentials` or writing outside its project root, without
  burning an LLM call per file touch.

If you're running agents with hands on real systems and you've been
white-knuckling through `--dangerously-skip-permissions`, this is for you.

---

## Credits

Built by **Simon Dixon** ([@inkie](https://inkie.ink)) and **Io**, his AI coordinator, starting April 2026. Platform-side implementation by **Doctor Two**, a Claude Code agent specialising in classifier internals and the OpenClaw runtime.

---

## Contributing

Early days. Issues + discussion welcome on GitHub. If you're running an agentic dev workflow and have an opinion about classifier behaviour, drop a note — failure modes from the wild are the most useful input.

**Writing an adapter for a new runtime?** See [`docs/adapter-guide.md`](./docs/adapter-guide.md) — five contracts, ~150 lines of glue, three shipped adapters as worked examples.

---

## License

MIT — see [LICENSE](./LICENSE).
