# io-auto-mode

> A hybrid static + LLM exec security classifier for AI coding agents.
> Stops prompt injection and accidental destruction without making automation impossible.

**Status:** early (`v0.1.0`). OpenClaw, Claude Code, Cursor, Antigravity (agy), and Codex adapters all shipping. Claude Code adapter has been in production use for ~2 weeks; Cursor, agy and Codex adapters are fresh. Tests cover static patterns, file zones, runtime schema mappings, MCP policy/redaction and adapter decisions (340 tests). Looking for feedback from people running agentic dev workflows.

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

Static-layer hits (~30% of all calls in our usage) are free. Stage 1 is one short LLM call per agent action; Stage 2 is rarer + slightly chunkier. The current shipped runtime uses Gemini; a provider-agnostic path for local LLMs is planned in [`specs/ai-sdk-migration.md`](./specs/ai-sdk-migration.md).

---

## Benchmark evidence

The [INK-923 benchmark](./docs/benchmarks/ink-923-jev-vs-gemini.md) compares Jev with pinned Gemini variants on fixture data; the [raw evidence bundle](./docs/benchmarks/ink-923-jev-2026-09-20/) includes the methodology and results. It is benchmark-only evidence, not a live provider switch.

### Jev and the provider boundary

Jev is TypeSafe System One. Its benchmark adapter asks typed `Choice`
questions and receives a decision plus probabilities, rather than generated
text. The pinned benchmark model is `jev-1.13.0`; the adapter lives in
[`benchmarks/jev-choice.ts`](./benchmarks/jev-choice.ts) and is not used by the
installed runtime or its provider selection. Jev integration remains a future
boundary, pending an explicit runtime adapter and configuration contract.

---

## What's in the repo

```
core/                      Shared classifier logic — no platform deps
  classifier.ts            Hybrid static + LLM pipeline
  static-patterns.ts       Hard-coded regex layer
  transcript.ts            Conversation context extraction
adapters/
  openclaw/                OpenClaw plugin (reference impl)
  claude-code/             Claude Code PreToolUse hooks (Bash + MCP + file)
  cursor/                  Cursor hooks (prompt + shell + MCP + file + write/edit)
  antigravity/             Antigravity (agy) PreToolUse classifier hook
  codex/                   Codex PreToolUse classifier hook (Bash + apply_patch)
specs/                     Future-work design specs (AI SDK migration, ...)
docs/                      Contributor docs — adapter guide etc.
tests/                     Tier 1 tests — static patterns + file-hook zones + cursor/agy/codex mappings
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
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hooks can read it
mkdir -p ~/.io-auto-mode
echo 'GOOGLE_GENERATIVE_AI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

# 3. Wire the three PreToolUse matchers into ~/.claude/settings.json
#    (full snippet in INSTALL.md — Bash + mcp__.* + Read|Write|Edit)

# 4. Restart your Claude Code session, then watch decisions land
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

Three matchers register: Bash and MCP calls use the LLM-backed fail-closed classifier; file operations use the path classifier.

---

## Quick start (Cursor)

See [`INSTALL.md`](./INSTALL.md) for the full guide. TL;DR:

```bash
# 1. Clone + install + build the adapter
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hooks can read it
mkdir -p ~/.io-auto-mode
echo 'GOOGLE_GENERATIVE_AI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

# 3. Wire five hooks into ~/.cursor/hooks.json
#    (full snippet in INSTALL.md — beforeSubmitPrompt, beforeShellExecution,
#     beforeMCPExecution, beforeReadFile, preToolUse with matcher Edit|Write)

# 4. Restart Cursor, then watch decisions land
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

Five hooks total: shell and MCP classifiers, a file classifier, and prompt capture that gives Stage 2 conversation context for prompt-injection hardening.

---

## Quick start (Antigravity / agy)

[Antigravity](https://antigravity.dev) (CLI: `agy`) is the non-Anthropic generalist runtime on the team. Its `PreToolUse` hook fires before every tool call; the adapter gates `run_command` and canonical `mcp__server__tool` calls through the shared classifier.

**Contract:** the agy hook adapter reads camelCase JSON on **stdin** and emits `{"allowTool": bool}` on **stdout**, exiting 0 on every path. Shell infrastructure failures remain fail-open; MCP infrastructure failures fail closed. Read-only tools are allowed without classification.

```bash
# 1. Clone + install + build the adapter
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hook can read it
mkdir -p ~/.io-auto-mode
echo 'GOOGLE_GENERATIVE_AI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

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

**Scope (v1):** the agy adapter gates `run_command` and canonical MCP calls. File read/write zone classification remains on the roadmap.

---

## Quick start (Codex)

Codex fires a `PreToolUse` hook before every tool call. The adapter gates `Bash`, `apply_patch` and canonical `mcp__server__tool` calls through the same three-layer classifier as the other runtimes.

**Contract:** the hook reads snake_case request JSON on **stdin** and emits a response JSON on **stdout**, always exiting **0**. Allow is an *empty body* (`{}`); deny is `hookSpecificOutput.permissionDecision: "deny"` plus a non-empty `permissionDecisionReason`. Unknown non-MCP tools pass through with a stderr warning.

`apply_patch` is classified alongside `Bash` on purpose: a patch can write a malicious script, overwrite the hook itself, or append to `~/.bashrc`, laundering a payload past a shell-only gate.

```bash
# 1. Clone + install + build the adapter
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs

# 2. Drop your Gemini key where the hook can read it
mkdir -p ~/.io-auto-mode
echo 'GOOGLE_GENERATIVE_AI_API_KEY=your-key-here' >> ~/.io-auto-mode/.env

# 3. Wire the PreToolUse hook into .codex/hooks.json
#    Replace <repo-path> with the absolute path you cloned to.
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/codex/bin/pretooluse-hook.sh"
          }
        ]
      }
    ]
  }
}
```

A ready-to-edit template lives at `adapters/codex/hooks/hooks.json`.

Shares the same core classifier, `~/.io-auto-mode/config.json` config, `~/.io-auto-mode/.env` API keys, and `~/.io-auto-mode/auto-mode-log.jsonl` ledger as every other adapter -- decisions from this runtime are tagged `"adapter": "codex"`.

**Scope:** `Bash`, `apply_patch` and canonical MCP calls are classified. Codex has no hook-level "ask" state, so an `ask` decision collapses to **deny** (conservative). Unknown non-MCP tools pass through with a stderr warning that records only the tool name and input keys.

MCP arguments use a dedicated prompt rather than shell-command rules. Credential-shaped keys and values are redacted before model calls and ledger writes. Optional `mcpAllowPatterns` and `mcpBlockPatterns` regexes match the full canonical name; block wins when both match.

Codex also has a native MCP approval layer. For a server protected by this trusted `PreToolUse` hook, set its native mode to `approve` so Codex does not show a second prompt before the hook's decision:

```toml
[mcp_servers.apify]
default_tools_approval_mode = "approve"
```

Use a per-tool override for a narrower rollout:

```toml
[mcp_servers.apify.tools."call-actor"]
approval_mode = "approve"
```

---

## Configuration

All options under `plugins.entries.io-auto-mode.config`:

| Option | Default | Description |
|---|---|---|
| `mode` | `classify` | `classify` / `yolo` / `strict` |
| `stage1Model` | `google/gemini-3.8-flash` | Fast LLM for Stage 1 |
| `stage1Fallback` | `google/gemini-3.8-flash` | Stage 1 fallback |
| `stage2Model` | `google/gemini-3.8-flash` | Thinking LLM for Stage 2 |
| `stage2Fallback` | `google/gemini-3.8-flash` | Stage 2 fallback |
| `userAllowPatterns` | `[]` | Extra shell regex patterns always allowed |
| `userBlockPatterns` | `[]` | Extra shell regex patterns always blocked |
| `mcpAllowPatterns` | `[]` | MCP canonical-name regexes allowed before the LLM |
| `mcpBlockPatterns` | `[]` | MCP canonical-name regexes blocked before allow or the LLM |

Defaults are all-Gemini for cost + latency. The shipped adapters currently
call Gemini, and provider swapping is not a live installed-runtime feature.
The planned provider-agnostic migration is tracked in
[`specs/ai-sdk-migration.md`](./specs/ai-sdk-migration.md).

For the current Gemini runtime, create `~/.io-auto-mode/config.json` with the
stage models you want to use:

```json
{
  "mode": "classify",
  "stage1Model": "google/gemini-3.8-flash",
  "stage1Fallback": "google/gemini-3.8-flash",
  "stage2Model": "google/gemini-3.8-flash",
  "stage2Fallback": "google/gemini-3.8-flash"
}
```

Put the key in `~/.io-auto-mode/.env` as
`GOOGLE_GENERATIVE_AI_API_KEY=your-google-gemini-key-here`. The legacy
aliases `GEMINI_API_KEY` and `GOOGLE_API_KEY` are also accepted, in that order,
for existing installations. This configuration applies to the shipped
Gemini runtime only; it does not enable Jev.

For the `Read` / `Write` / `Edit` file-tool classifier, configure `fileZones` (allowRead / allowWrite / deny) in either user-global (`~/.io-auto-mode/config.json`) or per-project (`<project>/.io-auto-mode.json`). Layers merge.

### Optional: Mission Control consent receipts (off by default)

The Claude Code adapter can accept a **signed consent receipt** — evidence that a human tapped a decision card — and upgrade an `ask` or `block` verdict to `allow`. It is upgrade-only (an `allow` is never downgraded) and fails closed on any error.

**It is an authorisation bypass by design, so it is disabled unless BOTH a consent directory and a signing key are configured** — the directory from either the `IO_AUTO_MODE_CONSENT_DIR` env var or `consentDir` in `~/.io-auto-mode/config.json`, and the key from the `MC_CONSENT_HMAC_KEY` env var (env-only; never read from the config file). A receipt only counts if its HMAC verifies, it is inside its TTL, and its scope explicitly names the tool and matches the command — an empty scope authorises nothing. `ask` upgrades are multi-use within the TTL; `block` upgrades additionally require a `confirmed: true` two-tap and are consumed single-use via atomic rename before the allow is emitted.

The consent directory must be **write-denied to the agents being gated** (put it on your `fileZones` deny list) — an agent that can write its own receipts can authorise itself. The HMAC is symmetric, so this defends against sloppy self-authorisation and prompt-injected forgery, **not** against an adversary already running as the same uid.

Full setup, the receipt schema, and the threat boundary: [`INSTALL.md`](./INSTALL.md#optional-mission-control-consent-receipts).

---

## Decision log

Every classification is logged with timestamp, command, stage (static / stage1 / stage2 / error), decision, duration, model used, and chain-of-thought reasoning where applicable:

```
~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

Useful both for debugging surprising blocks and for reviewing what your agent has been up to.

---

## Status & roadmap

- [x] OpenClaw adapter (exec + bundle MCP classifier)
- [x] Per-project config overlays
- [x] Static-layer hardening (top-level critical-dir rule, mid-path glob matching)
- [x] Claude Code adapter (PreToolUse hooks; in production ~2 weeks)
- [x] Cursor adapter (`beforeSubmitPrompt` + shell + MCP + file hooks; prompt-injection-hardening parity with Claude Code)
- [x] Antigravity (agy) adapter (`PreToolUse` matcher:* -- `run_command` + canonical MCP classifier)
- [x] Codex adapter (`PreToolUse` matcher:.* -- `Bash` + `apply_patch` + MCP classifier, empty-body-allow contract, fail-open)
- [x] Tier 1 tests -- static patterns + file zones + runtime schema mappings + MCP policy/redaction (tsx --test)
- [x] CI -- GitHub Actions running typecheck + tests on every push / PR
- [ ] Tier 2 tests — full classifier pipeline (mocked LLM) + transcript prompt-injection coverage
- [x] MCP tool classifier — shared canonical policy and redaction across all five adapters
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
