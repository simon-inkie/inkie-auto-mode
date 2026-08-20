#!/bin/bash
# io-auto-mode -- Codex PreToolUse safety classifier entry.
# Reads the Codex PreToolUse request JSON on stdin, emits a Codex hook response
# JSON on stdout. The exit code is ALWAYS 0: a deny is carried by the response
# body, never by the exit status (see src/types.ts for the full contract).
# Fails OPEN (empty body = allow) if the handler is missing -- a broken
# classifier must never hard-brick the agent.
#
# Deploy: wire this script's absolute path into .codex/hooks.json as the
# PreToolUse command hook (replace __ADAPTER_ROOT__ in adapters/codex/hooks/hooks.json
# with the absolute path to adapters/codex/).

set -u

# CODEX_ADAPTER_ROOT is the adapter root. When invoked from a bundled dist
# layout it may be pre-set; when invoked from the repo, derive it from this
# script's location.
: "${CODEX_ADAPTER_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"
export CODEX_ADAPTER_ROOT

# Candidate layouts, probed in order (mirrors the antigravity adapter):
#   1. <root>/dist/pretooluse-hook.js  -- bundled layout (built by scripts/build.mjs)
#   2. <root>/src/pretooluse-hook.ts   -- dev mode (tsx)
if [[ -f "${CODEX_ADAPTER_ROOT}/dist/pretooluse-hook.js" ]]; then
  exec node "${CODEX_ADAPTER_ROOT}/dist/pretooluse-hook.js"
fi

if [[ -f "${CODEX_ADAPTER_ROOT}/src/pretooluse-hook.ts" ]]; then
  exec npx --yes tsx "${CODEX_ADAPTER_ROOT}/src/pretooluse-hook.ts"
fi

# Fail-open: allow the tool call if the handler is missing. An EMPTY body is
# the allow signal -- emitting permissionDecision:"allow" explicitly is
# rejected by Codex's parser as unsupported (see src/types.ts).
echo '{}'
exit 0
