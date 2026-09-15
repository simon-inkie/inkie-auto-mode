# io-auto-mode — Installation Guide

A hybrid static + LLM exec security classifier for AI coding agents.
Intercepts every shell command and file-tool call before execution and
classifies it as allow / ask / block.

Five adapters are supported:

- [Claude Code](#claude-code) — `PreToolUse` hooks (Bash + MCP + Read/Write/Edit)
- [Cursor](#cursor) — shell + MCP + file hooks + prompt capture
- [Antigravity (agy)](#antigravity-agy) — `PreToolUse` classifier (`run_command` + canonical MCP)
- [Codex](#codex) — `PreToolUse` classifier (`Bash` + `apply_patch`)
- [OpenClaw](#openclaw) — `before_tool_call` plugin

Pick whichever runtime you use; they all share the same `core/` classifier.

---

## Requirements

- Node.js 22+
- A Google Gemini API key (defaults use `gemini-3.1-flash-lite` for both Stage 1
  and the Stage 2 thinking classifier: fast, cheap, and accurate enough for
  classification). You can swap providers
  via config; see Configuration Reference below.
- For the OpenClaw adapter: OpenClaw **2026.4.2+**.

---

## Claude Code

Hooks register at `PreToolUse` for `Bash` and `mcp__.*` (LLM-backed,
fail-closed) and `Read|Write|Edit` (path-based, sub-millisecond). All decisions log to
`~/.io-auto-mode/auto-mode-log.jsonl`.

### Step 1: Clone, install, build

```bash
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs
```

The build emits `adapters/claude-code/dist/hook.js` and
`adapters/claude-code/dist/file-hook.js`. The wrapper scripts at
`adapters/claude-code/bin/` will use these by default and fall back to running
the TypeScript directly via `tsx` if you're hacking on the adapter.

### Step 2: Provide your API key

Claude Code hooks run in a sandboxed environment that doesn't inherit your
shell's environment variables. Drop your key into a `.env` file the hook can
read:

```bash
mkdir -p ~/.io-auto-mode
cat > ~/.io-auto-mode/.env <<'EOF'
GOOGLE_GENERATIVE_AI_API_KEY=your-google-gemini-key-here
EOF
chmod 600 ~/.io-auto-mode/.env
```

`GOOGLE_GENERATIVE_AI_API_KEY` is the canonical name. `GEMINI_API_KEY` and
`GOOGLE_API_KEY` are still read as fallbacks, in that order, so existing
installs keep working.

Anthropic / OpenAI / other provider keys go in the same file if you've
configured those models. The legacy path `~/io-data/.env` is also accepted
for back-compat.

### Step 3: Wire the hooks into `~/.claude/settings.json`

Add the following under `hooks.PreToolUse` in `~/.claude/settings.json`,
substituting `<repo-path>` for the absolute path you cloned to:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/claude-code/bin/classify.sh",
            "timeout": 8,
            "async": false
          }
        ]
      },
      {
        "matcher": "mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/claude-code/bin/classify.sh",
            "timeout": 8,
            "async": false
          }
        ]
      },
      {
        "matcher": "Read|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/claude-code/bin/classify-file.sh",
            "timeout": 2,
            "async": false
          }
        ]
      }
    ]
  }
}
```

If you already have `PreToolUse` entries for other tools, merge — don't
overwrite. The three `matcher` keys (`Bash`, `mcp__.*` and `Read|Write|Edit`) target
different tool-call types and are independent.

### Step 4: Restart your Claude Code session

Hook config is read at session start. Quit and re-launch `claude`.

### Step 5: Verify

In a Claude Code session, ask the agent to run a benign command (e.g. `ls`).
You should see no prompt — the static-allow pattern fires at sub-millisecond.
Then check the log:

```bash
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

You should see one entry per tool call, with `stage`, `decision`, and
`durationMs` fields.

### Optional: configure file zones

By default, the file-hook denies access to `~/.ssh/`, `~/.aws/`, `~/.gnupg/`,
`/etc/`, `/usr/`, etc., and only allows reads/writes inside the project
directory + `/tmp/`. To extend either list, create `~/.io-auto-mode/config.json`:

```json
{
  "fileZones": {
    "allowRead": ["~/git-repos/**"],
    "allowWrite": ["~/scratch/**"]
  }
}
```

Or `<project>/.io-auto-mode.json` for project-scoped overrides. Layers merge
additively; the global deny list cannot be weakened.

### Optional: Mission Control consent receipts

> **This feature can turn a `block` into an `allow`.** It is an authorisation
> bypass by design. Read this whole section before enabling it, and do not
> enable it unless you control the process that writes the receipts.

**Off by default.** The layer is inert unless **both** of these are set:

| Setting | Where | Purpose |
|---|---|---|
| `IO_AUTO_MODE_CONSENT_DIR` | env var, or `consentDir` in `~/.io-auto-mode/config.json` | Directory the receipt files are read from |
| `MC_CONSENT_HMAC_KEY` | env var only | Shared key the receipts are signed with |

If either is missing the layer does nothing and the classifier behaves exactly
as it does without it. There is no partial-enable state.

**What it does.** When the core classifier returns `ask` or `block`, the layer
looks for a signed consent receipt authorising that specific action. If it
finds a valid one, the decision becomes `allow`. It is strictly upgrade-only —
an `allow` is never downgraded — and it fails closed: a missing directory,
malformed JSON, bad signature, expired window or lost rename race all mean *no
upgrade*, never an accidental allow.

A receipt only counts if **every** one of these holds:

- the HMAC over its canonical payload verifies against `MC_CONSENT_HMAC_KEY`
- the current time is inside its `tappedAt` … `expiresAt` window
- its `authorises` scope names the tool **and** matches the command against an
  explicit pattern. An absent or empty scope authorises **nothing** — a tap is
  consent to *an* action, never to any action.

**Receipt format.** One JSON file per receipt in the consent directory, named
`<decisionId>.json`:

```json
{
  "decisionId": "CARD-1234",
  "agent": "my-agent",
  "option": "A",
  "confirmed": false,
  "authorises": {
    "tools": ["Bash"],
    "patterns": ["example-cmd run*"]
  },
  "tappedAt": "2026-06-10T15:55:00Z",
  "expiresAt": "2026-06-10T16:25:00Z",
  "hmac": "<hex sha256>"
}
```

| Field | Required | Meaning |
|---|---|---|
| `decisionId` | yes | Non-empty id; also the filename stem, and what `MC_ACTING_ON=` refers to |
| `authorises.tools` | yes | Tool names this receipt covers. The tool must appear here |
| `authorises.patterns` | yes | Command patterns; literal text with `*` wildcards, anchored at both ends. Must be non-empty |
| `tappedAt` / `expiresAt` | yes | ISO 8601. Outside this window the receipt is ignored |
| `confirmed` | only for `block` | `true` marks the two-tap. Required to upgrade a `block`; ignored for `ask` |
| `hmac` | yes | Hex SHA-256 HMAC over the receipt with `hmac` removed and keys sorted at every level |
| `agent`, `option` | no | Carried for audit; not consulted when deciding |

The signed payload is the receipt object **minus `hmac`**, JSON-serialised with
object keys sorted at every level, so writer and verifier agree byte-for-byte.
`signReceipt()` in `adapters/claude-code/src/consent.ts` is the reference
implementation — write your receipts with that exact canonicalisation or the
HMAC will not verify.

**Two friction classes**, which behave differently and deliberately so:

| Core verdict | Receipt requirement | Reuse |
|---|---|---|
| `ask` (standard) | valid + in scope | **Multi-use** within the TTL |
| `block` (destructive) | valid + in scope + `confirmed: true` (the two-tap) | **Single-use** — consumed by atomic rename to `<id>.used.json` *before* the allow is emitted, so one tap is one execution and concurrent callers have exactly one winner |

**The directory is part of the security boundary.** The receipt is the
authoritative artefact, so the consent directory must be **write-denied to the
agents being gated** — put it on the `deny` list in your `fileZones` config. If
an agent can write its own receipts, it can authorise itself and the gate is
worthless. Human-readable approval text sitting in a chat log or thread file is
never consulted; only a signed receipt counts.

**Threat model — what this does and does not protect against.** It defends
against an agent sloppily self-authorising, and against prompt-injected text
talking an agent into believing it was approved. It does **not** defend against
an adversary already executing as the same uid: the HMAC is symmetric, so the
verifier holds the signing key, and anything that can read that key can mint
receipts. If the signer ever needs to live in its own trust domain, this should
move to asymmetric signing. Treat it as a layer, not a perimeter.

An optional leading `MC_ACTING_ON=<id>` assignment on a command only sets which
receipt is *tried first*. The scope match is still the real gate, so a lying
declaration buys nothing.

---

## Cursor

Cursor's hooks system fires at five points the classifier cares about:

- `beforeSubmitPrompt` — captures the user's prompt + attachments to a
  per-conversation cache so the next shell-execution call has conversation
  context for prompt-injection-hardened classification.
- `beforeShellExecution` — Bash classifier, LLM-backed, fail-closed.
- `beforeMCPExecution` — MCP classifier, LLM-backed, credential-redacted and fail-closed.
- `beforeReadFile` — file classifier, path-based, sub-millisecond.
- `preToolUse` (matched on `Edit|Write` only) — file classifier for write/edit
  tool calls.

All decisions log to `~/.io-auto-mode/auto-mode-log.jsonl`, with `conversation_id`,
`cursor_version`, `workspace_roots`, and (when logged in) `user_email`
populated for richer audit attribution.

### Step 1: Clone, install, build

```bash
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs
```

The build emits three handler bundles into `adapters/cursor/dist/`:

```
adapters/cursor/dist/
├── hook.js          # beforeShellExecution + beforeMCPExecution
├── file-hook.js     # beforeReadFile + preToolUse(Edit|Write)
└── prompt-hook.js   # beforeSubmitPrompt
```

Wrappers at `adapters/cursor/bin/` invoke these by default and fall back to
running the TypeScript via `tsx` if you're hacking on the adapter.

### Step 2: Provide your API key

Cursor hooks (like Claude Code's) run in a sandboxed environment that doesn't
inherit your shell's environment variables. Put your Gemini key in:

```bash
mkdir -p ~/.io-auto-mode
cat > ~/.io-auto-mode/.env <<'EOF'
GOOGLE_GENERATIVE_AI_API_KEY=your-google-gemini-key-here
EOF
chmod 600 ~/.io-auto-mode/.env
```

Same path the Claude Code adapter uses. Anthropic/OpenAI keys go in the same
file if you've configured those models. The legacy `~/io-data/.env` is also
accepted for back-compat.

### Step 3: Wire the five hooks into `~/.cursor/hooks.json`

Add the following, substituting `<repo-path>` for the absolute path you
cloned to:

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
    "beforeMCPExecution": [
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

The five hooks together give prompt-injection-hardening parity with the
Claude Code adapter — the README's "assistant text excluded from classifier
input" guarantee holds across both runtimes via different mechanisms.

`failClosed: true` on `beforeShellExecution` and `beforeMCPExecution` because
those are the high-stakes paths. The other three are fail-open (parity with the Claude Code adapter and
because the prompt-capture/file-zone hooks are auxiliary).

You can also drop this in a project-local `<project>/.cursor/hooks.json` if
you'd rather configure per-repo than user-global.

### Step 4: Restart Cursor

Cursor reads hooks.json at session start. Quit and relaunch.

### Step 5: Verify

Open a Cursor session and ask the agent to run a benign command (e.g. `ls`).
Static-allow patterns fire at sub-millisecond and you should see no
permission prompt. Then check the log:

```bash
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

Each entry includes `stage`, `decision`, `durationMs`, and (for Cursor)
`conversation_id`. Send a follow-up message and watch a new
`prompt-capture` entry land before the next shell-execution decision.

### Optional: configure file zones

Same `~/.io-auto-mode/config.json` as the Claude Code adapter — see Step 5
of the Claude Code section above. Cursor and Claude Code share the same zone
config; one place to maintain the rules for both runtimes.

### Known limitations

- **`beforeReadFile` cannot say "ask"** — Cursor's schema only allows
  `permission: "allow" | "deny"` for file reads. The adapter collapses any
  would-be `ask` decision to `deny`. If you hit a deny on a path you trust,
  add it to `allowRead` in `~/.io-auto-mode/config.json` rather than waiting
  for an ask prompt.
- **Tab hooks not yet covered** — `beforeTabFileRead` and `afterFileEdit`
  protect Cursor's autonomous Tab completion, not Agent flows. Planned for
  a follow-up release; see [`specs/cursor-adapter.md`](./specs/cursor-adapter.md)
  §11.
- **Cloud agents do not fire `beforeMCPExecution`** — Cursor currently exposes
  that hook for local IDE Agent runs only.

---

## Antigravity (agy)

[Antigravity](https://antigravity.dev) (CLI: `agy`) fires a `PreToolUse` hook before
every tool call. The adapter classifies `run_command` and canonical
`mcp__server__tool` calls through the same `core/`
classifier as the other runtimes; read-only and agy-internal tools pass straight
through. The hook reads agy's hook JSON on stdin and emits `{"allowTool": bool}` on
stdout, exiting 0 on every path. Existing shell infrastructure failures remain
fail-open; MCP configuration and classifier failures fail closed.

### Step 1: Clone, install, build

```bash
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs
```

The build emits `adapters/antigravity/dist/pretooluse-classify.js`. The wrapper at
`adapters/antigravity/bin/pretooluse-classify.sh` uses it by default and falls back
to running the TypeScript via `tsx` if you're hacking on the adapter.

### Step 2: Provide your API key

agy hooks run as subprocesses that don't inherit your shell's environment. Drop your
Gemini key where the hook can read it:

```bash
mkdir -p ~/.io-auto-mode
cat > ~/.io-auto-mode/.env <<'EOF'
GOOGLE_GENERATIVE_AI_API_KEY=your-google-gemini-key-here
EOF
chmod 600 ~/.io-auto-mode/.env
```

Same path the Claude Code and Cursor adapters use. The legacy `~/io-data/.env` is
also accepted.

### Step 3: Wire the PreToolUse hook into `.agents/hooks.json`

Add the following to your agy project's `.agents/hooks.json`, substituting
`<repo-path>` for the absolute path you cloned to. A ready-to-edit template lives at
`adapters/antigravity/hooks/hooks.json`:

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

If you already have a `PreToolUse` entry, merge — don't overwrite.

### Step 4: Restart your agy session

Hook config is read at session start. Restart `agy`.

### Step 5: Verify

Ask the agent to run a benign command (e.g. `ls`); it proceeds (static-allow patterns
resolve at sub-millisecond before any LLM call). For each classified `run_command` or MCP call
the adapter writes a diagnostic JSON line to **stderr** (`event: classified`, with
the `decision` + `stage`), so you can confirm it's gating by watching agy's hook
stderr.

### Scope + known limitations

- **v1 gates `run_command` and canonical MCP names** — MCP calls must arrive as
  `mcp__server__tool`, matching the runtime hook contract.
  File read/write zone classification under agy (as the Claude Code and Cursor
  adapters do via their file hooks) is on the roadmap; until then, file tools pass
  through.
- **Bool-only result, no native "ask"** — agy's `PreToolUse` result is
  `{"allowTool": bool}`. The adapter collapses any `ask` decision to **block**
  (conservative): an escalated command is refused rather than prompted.
- **Strict unmarshal** — agy parses the result with strict protojson, so the adapter
  emits *exactly* `{"allowTool": bool}` and nothing else (any extra field makes agy
  default to allow).

---

## Codex

Codex fires a `PreToolUse` command hook before every tool call. The adapter
classifies `Bash`, `apply_patch` and canonical `mcp__server__tool` calls through
the same `core/` classifier as the other runtimes. Unknown non-MCP tools pass
straight through. The hook reads
Codex's snake_case request JSON on stdin and emits a response JSON on stdout,
**always exiting 0** — a block is carried by the response body, never by the exit
code.

`apply_patch` coverage is the reason this adapter classifies two tools rather than
one: a patch can write a malicious script, overwrite the hook itself, or append to
`~/.bashrc`, laundering a payload past a Bash-only gate. Both tools carry their
content under the same `tool_input.command` field, so both are classified the
same way.

### Step 1: Clone, install, build

```bash
git clone https://github.com/simon-inkie/inkie-auto-mode.git io-auto-mode
cd io-auto-mode
pnpm install
node scripts/build.mjs
```

The build emits `adapters/codex/dist/pretooluse-hook.js`. The wrapper at
`adapters/codex/bin/pretooluse-hook.sh` uses it by default and falls back to
running the TypeScript via `tsx` if you're hacking on the adapter.

### Step 2: Provide your API key

Codex hooks run as subprocesses that don't inherit your shell's environment. Drop
your Gemini key where the hook can read it:

```bash
mkdir -p ~/.io-auto-mode
cat > ~/.io-auto-mode/.env <<'EOF'
GOOGLE_GENERATIVE_AI_API_KEY=your-google-gemini-key-here
EOF
chmod 600 ~/.io-auto-mode/.env
```

Same path every other adapter uses. `GEMINI_API_KEY` and `GOOGLE_API_KEY` are read
as fallbacks; the legacy `~/io-data/.env` is also accepted.

### Step 3: Wire the PreToolUse hook into `.codex/hooks.json`

Add the following to your `.codex/hooks.json`, substituting `<repo-path>` for the
absolute path you cloned to. A ready-to-edit template lives at
`adapters/codex/hooks/hooks.json` — replace its `__ADAPTER_ROOT__` placeholder with
the absolute path to `adapters/codex/`:

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

The `.*` matcher is deliberate: the hook fires for every tool, and the adapter
itself decides what to classify. If you already have a `PreToolUse` entry, merge —
don't overwrite.

### Step 4: Restart your Codex session

Hook config is read at session start. Restart Codex.

For each MCP server protected by this trusted hook, suppress Codex's duplicate
native prompt by setting its approval mode to `approve` in `config.toml`:

```toml
[mcp_servers.example]
default_tools_approval_mode = "approve"
```

For a narrower rollout, use a quoted per-tool table:

```toml
[mcp_servers.example.tools."write-item"]
approval_mode = "approve"
```

The trusted `PreToolUse` hook still allows or denies the call before execution.

### Step 5: Verify

Ask the agent to run a benign command (e.g. `ls`); it proceeds, resolved by a
static-allow pattern at sub-millisecond before any LLM call. For each classified
call the adapter writes a diagnostic JSON line to **stderr** (`event: classified`,
with `toolName`, `decision` and `stage`), and every classified decision also lands
in the shared ledger:

```bash
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

Entries from this adapter are tagged `"adapter": "codex"`, so you can tell them
apart from the other runtimes sharing the same log.

### Scope + known limitations

- **`Bash`, `apply_patch` and MCP calls are classified** — MCP calls get a
  dedicated prompt, deterministic canonical-name policy, credential redaction,
  and the same audit ledger as shell calls. Unknown non-MCP tools pass through
  with a warning that records names and input keys, never raw values.
- **No native "ask"** — Codex's `PreToolUse` hook has no ask state. The adapter
  collapses any `ask` decision to **deny** (conservative): an escalated command is
  refused rather than prompted.
- **Deny requires a reason** — Codex rejects a deny with an empty or missing
  `permissionDecisionReason`, so the adapter always supplies one, falling back to a
  generic string if the classifier returned no reason.
- **`apply_patch` patches are classified verbatim** — the raw patch text goes to
  the classifier. Static BLOCK patterns are substring-matched, so a patch body
  containing shell-looking text can be denied even when the edit is legitimate.
  That fails safe. In the other direction, a model refusal that objects only to the
  *format* ("this isn't a shell command") is treated as an abstention rather than a
  real deny, because static analysis has already cleared the patch content by that
  point.

---

## OpenClaw

Reference implementation. Plugin loads from source at runtime; no pre-build
step needed.

> **Note:** `openclaw` is an *optional peer dependency* of `io-auto-mode`.
> Claude Code and Cursor users get a tiny ~400KB install. To use the
> OpenClaw adapter, add it to your project explicitly:
>
> ```bash
> pnpm add openclaw      # or npm install openclaw
> ```

---

### Step 1: Register your AI provider key

**Do NOT use `openclaw onboard`** — it reruns the full setup wizard.

Use `openclaw models auth login` instead. It picks up existing env vars
automatically and doesn't touch your default model:

```bash
# Google / Gemini (used by default config for all stages)
openclaw models auth login --provider google --method gemini-api-key
```

This will detect an existing `GEMINI_API_KEY` env var and prompt to confirm.
Omit `--set-default` to keep your current default model. If you'd rather route
some stages through Anthropic, OpenAI, etc., register those provider keys too
and set the model strings in config (see Configuration Reference).

---

### Step 2: Add plugin to `openclaw.json`

Add to `plugins.load.paths` so OpenClaw discovers it on startup:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/io-auto-mode"]
    },
    "entries": {
      "io-auto-mode": {
        "enabled": true,
        "config": {
          "mode": "classify",
          "stage1Model": "google/gemini-3.1-flash-lite",
          "stage1Fallback": "google/gemini-3.1-flash-lite",
          "stage2Model": "google/gemini-3.1-flash-lite",
          "stage2Fallback": "google/gemini-3.1-flash-lite"
        }
      }
    }
  }
}
```

Or use the gateway config patch command:

```bash
openclaw config patch '{"plugins":{"load":{"paths":["/path/to/io-auto-mode"]},"entries":{"io-auto-mode":{"enabled":true,"config":{"mode":"classify"}}}}}'
```

---

### Step 3: Restart gateway

```bash
openclaw gateway restart
```

---

### Step 4: Verify

Check the classifier is running and logging decisions:

```bash
tail -f ~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

Run a test command — you should see a log entry with `stage` and `decision`.

```bash
openclaw plugins list  # should appear as static allow at 0ms
```

The plugin also classifies OpenClaw bundle MCP tools named
`<server>__<tool>`. It normalises them to `mcp__server__tool` for shared policy,
redacts credential-shaped arguments before model and ledger use, and fails
closed if MCP classification infrastructure is unavailable.

---

## Configuration Reference

All options live under `plugins.entries.io-auto-mode.config`:

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `classify` | `classify` (normal), `yolo` (allow all), `strict` (block unless on allowlist) |
| `stage1Model` | `google/gemini-3.1-flash-lite` | Fast LLM for Stage 1 classification |
| `stage1Fallback` | `google/gemini-3.1-flash-lite` | Fallback if Stage 1 model unavailable |
| `stage2Model` | `google/gemini-3.1-flash-lite` | Thinking LLM for Stage 2 (escalated blocks) |
| `stage2Fallback` | `google/gemini-3.1-flash-lite` | Fallback if Stage 2 model unavailable |
| `userAllowPatterns` | `[]` | Additional regex patterns to always allow |
| `userBlockPatterns` | `[]` | Additional regex patterns to always block |

---

## Behaviour

| Outcome | What happens |
|---------|-------------|
| **allow** | Command runs silently |
| **ask** | Native approval overlay — you decide |
| **block** | Command refused with reason |

When classifier models are unavailable (API down, key missing):
- **Main session** (you present): surfaces as **ask** — you can approve
- **Sub-agents** (unattended): auto **block** — safe default

---

## Troubleshooting

### All exec calls are blocked / getting constant "ask" prompts
Classifier models are unavailable. Check `auto-mode-log.jsonl` for `stage: error` entries.
Fix: ensure provider keys are registered (Step 1).

### Deadlock — can't run any commands
Disable the plugin directly in `openclaw.json` (`enabled: false`) and restart:
```bash
# Run this in your terminal (not via your agent — it's locked out too!)
python3 -c "
import json, os
p = os.path.expanduser('~/.openclaw/openclaw.json')
with open(p) as f: cfg = json.load(f)
cfg['plugins']['entries']['io-auto-mode']['enabled'] = False
with open(p, 'w') as f: json.dump(cfg, f, indent=2)
print('disabled')
" && openclaw gateway restart
```

### Need to temporarily disable classification
Set `mode: "yolo"` in config and restart. All exec calls pass through, no classification.

### Latency is high (>500ms per command)
Extend the static ALLOW patterns in `src/static-patterns.ts` to cover more of
your common commands. Static matches resolve at 0ms before any LLM call.

---

## Decision Log

Every classification is logged to:
```
~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

Each entry includes: timestamp, command, stage (static/stage1/stage2/error),
decision, duration, model used, and chain-of-thought reasoning (Stage 2).
