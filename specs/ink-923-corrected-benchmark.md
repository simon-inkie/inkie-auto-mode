# INK-923 corrected provider benchmark

## Scope

Correct the benchmark-only Gemini/Jev seam without changing installed adapters,
live routes, provider selection, configuration, or the 159-fixture corpus.

## Contract

- The runner invokes the shared classifier once per fixture for both providers.
- Static decisions stay in the shared classifier and make zero provider calls.
- Every dynamic provider call receives an explicit `stage1` or `stage2` value.
- Stage 1 carries an explicit 1,024-token output budget in both provider
  requests. Gemini combines it with the model's supported `low` thinking level
  so reasoning does not consume the visible decision budget. Jev records the
  budget in typed request state because System One Choice does not expose a
  generation-token control. Stage selection never depends on that budget.
- Each provider returns the classifier's existing string contract plus normalised
  usage, confidence, elapsed provider-call time, and redacted errors.
- Each request has an abort-backed 20-second timeout whose timer is unrefed and
  cleared after settlement. Jev receives the same signal through its SDK.
- Provider failures produce null benchmark decisions and are excluded from pass,
  safety-miss, and disagreement rates. Any provider error fails the batch.
- Result order is repeat, Gemini then Jev, then fixture ID. Each of four clean
  repeats executes Gemini before Jev.

## Provider differences disclosed

The shared classifier system prompt and fixture inputs are the same. Jev also
requires stage-specific structured Choice criteria. Gemini receives temperature
as a generation control; Jev cannot set it and records it only in request state.

## Verification

- Unit and contract tests cover both stages, static no-call behaviour, explicit
  stage routing, Stage 1 budget/non-empty output, timeout abort and cleanup,
  normalised errors, and deterministic ordering.
- Frozen install, full tests, typecheck, lint, build, and diff check pass.
- Four clean full-corpus pairs complete with zero provider errors.
- Earlier runs remain quarantined and labelled invalid exploratory evidence.
- The amended report includes four-run aggregates, range/variance, and
  within-provider run-to-run disagreement.
