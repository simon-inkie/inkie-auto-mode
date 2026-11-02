# Jev non-authoritative shadow

## Objective

Add an opt-in Jev shadow to the existing Gemini-backed dynamic classifier. Gemini remains the only enforcement authority. Jev observes the same already-built dynamic classifier input and produces local comparison telemetry, but its result is never returned to an adapter, mapped to a permission, or used by consent handling.

This change starts from GitHub `master` at `f17615b4cffbd6d96768ed464c646507a6151679`. It must not modify or consume the preserved INK-923 worktree or its exploratory outputs. The native-prompt final benchmark is a separate later change.

## Invariants

1. The value returned by `classify()` is exactly the Gemini result that would have been returned with shadowing disabled.
2. Jev network work runs outside the enforcement process. The adapter does not await it. Jev success, mismatch, malformed output, missing credentials, timeout, process-launch failure, telemetry failure, or provider failure cannot change, fail, or wait on the Gemini decision.
3. The feature is disabled by default. Disabled means no Jev client construction, worker process, network call, shadow file, or extra telemetry.
4. Static decisions, `yolo`, strict-mode static decisions, policy-resolved MCP calls, and classifier error results are not eligible. An eligible result is a successful dynamic final decision whose selected enforcement model is a Google Gemini model and whose stage is `stage1`, `stage2`, or `fallback`.
5. The shadow compares against the final Gemini classifier decision before any adapter-specific mapping or Claude Code consent-receipt upgrade. Human consent is not a Gemini prediction and must not be labelled as one.
6. No command, transcript, prompt, tool arguments, headers, unstructured provider response, reasoning, or raw error text enters shadow telemetry, argv, or environment metadata. The credential remains only in the existing `TYPESAFE_API_KEY` process environment and is never copied into a job or record.
7. Telemetry remains on the local filesystem. There is no analytics, callback, upload, or remote telemetry route. The Jev API receives only the classifier request needed to produce the shadow answer.

## Configuration

Extend `ClassifierConfig` with one bounded option:

```ts
jevShadow?: {
  enabled: boolean;
}
```

`DEFAULT_CONFIG.jevShadow.enabled` is `false`. The model, policy and thresholds are code-pinned rather than user-configurable:

```text
model: jev-1.13.0
stage 1 allow: P(ALLOW) >= 0.86
stage 2 block: P(BLOCK) >= 0.09, evaluated first
stage 2 allow: P(ALLOW) >= 0.61
otherwise: ASK
total job deadline: 30 seconds
provider retries: 0
```

The credential is resolved by the TypeSafe SDK from `TYPESAFE_API_KEY` only. It is never accepted in JSON config, copied into the job payload, or logged. Document the option and credential in README/INSTALL with the disabled-default and non-authoritative guarantees.

Config loaders must merge the nested default explicitly. A partial or malformed `jevShadow` value fails to disabled, never enabled. OpenClaw's explicit config resolver must receive the same option as the file-backed adapters.

## Architecture

### 1. Preserve the enforcement path

Keep Gemini classification in `core/classifier.ts`. Add an optional injected `ShadowDispatcher` to the existing classify options. Once a successful dynamic Gemini result is final, construct an immutable shadow job from the already-built `systemPrompt`, `userMessage`, action kind and Gemini result, then call the dispatcher's synchronous, non-throwing `dispatch(job)` method. Return the Gemini result immediately after dispatch. Do not use `Promise.all`, await a Jev promise, or put Jev inside Gemini fallback handling.

The dispatcher is absent when disabled. Adapter code is responsible only for constructing the shared dispatcher from validated config and supplying it to both shell and MCP classification. `classifyMcpCall` passes the dispatcher through to `classify`; MCP policy results that bypass `classify` remain ineligible.

The optional injection seam keeps benchmark calls, existing consumers and unit tests inert by default. A dispatcher exception is caught at the boundary and cannot escape `classify()`.

### 2. Detached one-job worker

The shared dispatcher launches a detached Node worker after the Gemini result is immutable. The worker is a dedicated bundled entry point, not a provider switch in any adapter. The adapter never waits for provider completion or the 30-second deadline.

- Pass the bounded job through the child's stdin only. Never put classifier input or credentials in argv, environment metadata, a temporary file, or a durable queue.
- Child stdout/stderr are ignored. The process and stdin handles are unreferenced after the bounded write so Jev cannot keep the hook alive.
- Spawn arguments contain only the worker module path. The child receives an allowlisted environment containing the TypeSafe credential and the minimum runtime variables required by Node.
- Cap the serialised stdin job size. Oversize input records a structured dispatch error without retaining the input.
- Build a worker artefact beside each bundled adapter entry so resolution is deterministic from `import.meta.url`. OpenClaw uses the same detached worker contract rather than an in-process special case.
- A worker-launch or stdin-delivery error is swallowed by enforcement and recorded locally when possible.

The implementation must include a subprocess timing test demonstrating that the adapter result settles before a hanging Jev worker reaches its deadline. Provider latency must not appear in the Gemini `durationMs`.

### 3. Jev Choice execution

Extract the reviewed, production-safe subset of `benchmarks/jev-choice.ts` into a shared Jev module; keep benchmark-only report and pricing concerns in `benchmarks/`. Both benchmark and shadow code should import the same constants and threshold function so policy cannot drift.

For the shadow job:

1. Ask the existing INK-923 `current` Stage 1 Choice using the same classifier system prompt and user message Gemini received.
2. Validate the typed response at runtime: allowed label, finite confidence and finite probabilities in `[0, 1]`. A malformed answer is a provider error, not a decision.
3. If `P(ALLOW) >= 0.86`, propose `allow` at Stage 1 and stop.
4. Otherwise ask the existing `current` Stage 2 Choice on the same input.
5. At Stage 2, propose `block` when `P(BLOCK) >= 0.09`; otherwise propose `allow` when `P(ALLOW) >= 0.61`; otherwise propose `ask`.

The raw Choice label is captured for audit but does not override thresholded-A. Stage 2 BLOCK precedence is explicit. One total abort-backed deadline covers both stages; pass its signal to every SDK call, set retries to zero, unref the timer, and clear it in `finally`. A failure at either stage yields no proposed action and status `provider_error` or `timeout`; do not convert provider failure into `ask`, `block`, or a fallback call.

## Local telemetry

Use a dedicated append-only JSONL file, defaulting to `~/.io-auto-mode/jev-shadow-log.jsonl`, with directory mode `0700` and file mode `0600`. Do not reuse `logDecision`, whose existing schema intentionally contains the command. Logging failure is non-fatal.

Bound the local log by rotating it before append when it reaches 10 MiB. Retain at most five numbered local generations beside the active file; rotation failure is non-fatal and must not affect enforcement. Rotation never uploads or copies the file outside the configured local directory.

Generate an opaque UUID correlation ID for each eligible Gemini result. Write a metadata-only `scheduled` event before launch and exactly one terminal event when possible. An unmatched scheduled event exposes worker loss rather than silently pretending the comparison completed.

Allowed schema:

```ts
type JevShadowEvent =
  | {
      schemaVersion: 1;
      event: 'scheduled';
      ts: string;
      correlationId: string;
      gemini: { decision: Decision; stage: DecisionStage };
    }
  | {
      schemaVersion: 1;
      event: 'completed';
      ts: string;
      correlationId: string;
      gemini: { decision: Decision; stage: DecisionStage };
      jev: {
        status: 'ok' | 'timeout' | 'provider_error' | 'dispatch_error';
        stages: Array<{
          stage: 'stage1' | 'stage2';
          choice: 'ALLOW' | 'ASK' | 'BLOCK';
          probabilities: Record<'ALLOW' | 'ASK' | 'BLOCK', number>;
          confidence: number;
        }>;
        proposedDecision: Decision | null;
        latencyMs: number;
      };
      drift: 'agree' | 'jev_more_permissive' | 'jev_more_restrictive' | 'unavailable';
    };
```

Normalise absent Choice labels to explicit zero probabilities before logging, after runtime validation. Drift ordering is `allow < ask < block`; equal actions are `agree`, a lower Jev rank is `jev_more_permissive`, a higher rank is `jev_more_restrictive`, and non-success is `unavailable`. Do not add raw error strings. Timestamp, schema version and pinned-model metadata may be constants in file documentation, not copied request content.

## Planned files

- `core/types.ts`: disabled-default config and shadow interfaces.
- `core/classifier.ts`: one post-Gemini, pre-adapter dispatch seam with unchanged return semantics.
- `core/mcp.ts`: pass the optional dispatcher through dynamic MCP classification.
- `core/jev-policy.ts`: pinned model, Choice criteria, runtime validation and thresholded-A function shared with benchmarks.
- `core/jev-shadow.ts`: eligibility, job schema, detached dispatcher, telemetry schema/redaction guard.
- `core/jev-shadow-worker.ts`: one-job TypeSafe execution, hard deadline and terminal telemetry.
- `benchmarks/jev-choice.ts`: consume the shared policy without changing preserved benchmark artefacts.
- the five runtime entry points under `adapters/{claude-code,cursor,codex,antigravity,openclaw}/`: validated config plus shared dispatcher injection only.
- `scripts/build.mjs`, `package.json`, `pnpm-lock.yaml`: bundle/publish worker artefacts and make the TypeSafe SDK a runtime dependency where required.
- `scripts/summarise-jev-shadow.ts`: local allowlist-only JSONL summariser with no request-content output.
- `tests/jev-shadow.test.ts` plus focused adapter/config/build tests.
- `README.md` and `INSTALL.md`: opt-in configuration, credential, local log and operational guarantees.

Do not edit files under `docs/benchmarks/ink-923-*`, benchmark raw outputs, fixtures, live/private configuration, routes, hooks outside this worktree, or any provider setting.

## Verification

Unit and contract tests must prove:

1. Default and malformed config perform zero spawn, zero Jev call and zero shadow-file creation.
2. Static, yolo, strict-static, MCP-policy and error-stage outcomes are ineligible.
3. Dynamic Gemini Stage 1 and Stage 2 results dispatch exactly once with the same already-built classifier input.
4. The exact threshold boundaries are pinned, including Stage 2 BLOCK precedence.
5. Success/agreement and success/mismatch telemetry are correct while the returned Gemini decision, model, stage, reason and duration remain byte-for-byte equivalent to shadow-disabled output.
6. A hanging Jev call is aborted at the total deadline, its timer is cleared/unrefed, the adapter result settles first, and timeout telemetry is `unavailable`.
7. Jev SDK rejection, malformed typed output, missing credential, worker launch failure, stdin failure and telemetry write failure cannot reject or alter Gemini enforcement.
8. Secret-bearing commands, prompts, headers and synthetic provider errors never occur in shadow JSONL, argv, environment metadata, stdout or stderr. Tests search for the canary values and assert only the allowlisted schema keys exist.
9. Stage 1 allow makes one Jev call; Stage 1 below threshold makes exactly two ordered calls; there are no retries.
10. Every terminal event joins to its scheduled event by opaque correlation ID; orphaned scheduled events are detectable.
11. Worker artefacts are present in every supported adapter build/package and resolve correctly from installed-style paths.
12. `pnpm shadow:summary [path]` reads only schema-version-1 allowlisted fields and reports eligible/scheduled/completed counts, agreement and drift breakdown, Jev status/error rate, Gemini/Jev stage mix, and p50/p95 terminal latency. It ignores unknown fields, emits no request content, and tolerates malformed lines, terminal records without schedules, and scheduled records without terminals while reporting those orphan counts.
13. Local telemetry rotates at 10 MiB and retains no more than five generations; rotation failure remains non-authoritative.

Run the full repository gates: frozen install, test suite, typecheck/lint, build, dist smoke, focused subprocess timing tests, and scoped diff check. Review the final code commit with Andor and Aggy before opening the MR. No live provider call is part of the implementation gate; any later live shadow smoke needs separate explicit authority and must use non-secret verification output.

## Acceptance

- With `jevShadow.enabled` absent or false, behaviour and artefacts are unchanged.
- With it true, every eligible successful Gemini dynamic classification gets a best-effort scheduled shadow record and an out-of-process Jev attempt.
- Gemini remains the sole enforcement result under success, disagreement, timeout and every Jev/telemetry/worker error path.
- Only the bounded local telemetry schema is durable; no request content or secret is persisted or emitted.
- Operators can summarise the local shadow log without exposing request content, and log retention is bounded to the active file plus five generations.
- No existing INK-923 artefact changes, no native-prompt benchmark, no live configuration or provider change, and no deployment.
