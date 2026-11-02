# Jev primary classifier

## Scope
Make Jev the default dynamic classifier for all five adapters. Publish branches only; no installation, runtime config changes, service restart, package publication or default-branch merge.

Based on the optional shadow implementation. Preserve that implementation on its own branch. Existing explicit Google/Anthropic model selections remain supported; fresh defaults use typesafe/jev-1.13.0 for both stages and fallbacks. Static policy, MCP policy, transcript/provenance and adapter permission mapping remain unchanged.

## Provider contract
Use the pinned current-prompt Choice questions and thresholded-A policy already shared by benchmark/shadow code. Stage 1 allows at P(ALLOW)>=0.86; otherwise escalates. Stage 2 blocks first at P(BLOCK)>=0.09, allows at P(ALLOW)>=0.61, otherwise asks. Validate response fields at runtime. Pin the model; reject unsupported TypeSafe models. Read TYPESAFE_API_KEY from the environment only. Bound each call to 10 seconds with abort plus an independent deadline, disable SDK retries, redact failures, and retain existing classifier error handling. No implicit Gemini fallback.

## Verification
Mock provider calls: both stages, boundary/precedence, malformed response, missing credentials, timeout including ignored abort, redacted errors, and adapter wiring. Full test suite, TypeScript, build and bundled MCP smoke check. Review all outgoing commit diffs and metadata for private identifiers/secrets, with synthetic test canaries distinguished from actual credentials. Do not make live benchmark calls.

## Follow-ups
Merge/deployment and any live provider canary need a separate instruction. Historical Gemini benchmark measurements remain labelled as historical, not Jev performance claims.

## Implementation receipt
Shared TypeSafe transport routes both Choice stages through all adapters. Added a strict primary-path probability completeness/sum check in addition to the shared label/confidence validator. SDK logging is off; public errors contain no raw provider text. Explicit Google configuration keeps the optional shadow tests independent of the new default. Nine focused transport/routing tests pass, including a fetch-mocked SDK call through Claude Code, Cursor and OpenClaw. Codex and Antigravity share the Claude Code transport import. Full gates and privacy review are pending at this commit.

The first full suite found one stale default-configuration expectation (403/404 passed): it still pinned Gemini. Updated that regression to pin Jev; provider behaviour was already covered by the nine passing new transport tests. No implementation change.
