# INK-927: Gemini API key header transport

## Scope

Move the Gemini `generateContent` API key from the URL query string to the
`x-goog-api-key` header in the Cursor, Claude Code and OpenClaw adapters.

## Contract

- The Google request URL contains no `key` query parameter.
- The chosen existing credential is sent as `x-goog-api-key`.
- Existing credential precedence, request payloads, response parsing and error
  behaviour remain unchanged.
- Tests capture the outgoing URL and headers and assert both the positive
  header case and the absent URL-key case for all three adapters.

## Boundaries

- No benchmark files or INK-923 worktree changes.
- No live provider call before patch review and an approved non-secret route.
- No key values in source, tests, logs, commits or MR text.
- No provider, endpoint, model default or runtime configuration change.

## Verification

Run `npm test`, `npm run typecheck` and `npm run build`. Obtain focused Andor
and Aggy reviews before opening the separate INK-927 MR.
