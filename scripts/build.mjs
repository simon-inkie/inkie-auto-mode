#!/usr/bin/env node
/**
 * Bundle the Claude Code and Cursor adapters into self-contained dist/
 * directories inside each adapter dir so they can be installed without
 * needing the TypeScript toolchain at install time.
 *
 * Mirrors the greymatter merge-day packaging pattern. The OpenClaw adapter
 * loads from source via load.paths and doesn't need a pre-build step.
 */

import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { rmSync, mkdirSync, existsSync, cpSync, chmodSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CC_ROOT = join(ROOT, "adapters/claude-code");
const DIST = join(CC_ROOT, "dist");
const CURSOR_ROOT = join(ROOT, "adapters/cursor");
const CURSOR_DIST = join(CURSOR_ROOT, "dist");
const AGY_ROOT = join(ROOT, "adapters/antigravity");
const AGY_DIST = join(AGY_ROOT, "dist");
const CODEX_ROOT = join(ROOT, "adapters/codex");
const CODEX_DIST = join(CODEX_ROOT, "dist");

const NODE_BUILTINS = [
  "fs", "fs/promises", "path", "os", "url", "util", "crypto",
  "child_process", "stream", "events", "buffer", "process", "http", "https",
  "net", "tls", "querystring", "zlib", "readline", "assert",
];
const EXTERNALS = [
  ...NODE_BUILTINS,
  ...NODE_BUILTINS.map((n) => `node:${n}`),
];

// Shebang banner so the dist files can act as npm `bin` entries directly.
// After the build, chmod +x makes them executable.
const SHEBANG = "#!/usr/bin/env node";

function makeExecutable(...paths) {
  for (const p of paths) {
    chmodSync(p, 0o755);
  }
}

if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

// Bash classifier (LLM-backed)
await build({
  entryPoints: [join(CC_ROOT, "src/hook.ts")],
  outfile: join(DIST, "hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

// File classifier (path-based, no LLM)
await build({
  entryPoints: [join(CC_ROOT, "src/file-hook.ts")],
  outfile: join(DIST, "file-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

// The core classifier reads prompts via `__dirname/../prompts/system.txt`.
cpSync(join(ROOT, "prompts"), join(CC_ROOT, "prompts"), { recursive: true });

// Mark the bundled outputs as executable so npm `bin` entries work directly.
makeExecutable(join(DIST, "hook.js"), join(DIST, "file-hook.js"));

console.log(`[build] claude-code bash hook  → ${DIST}/hook.js`);
console.log(`[build] claude-code file hook  → ${DIST}/file-hook.js`);
console.log(`[build] install:  claude --plugin-dir ${CC_ROOT}`);

// ---------------------------------------------------------------------------
// Cursor adapter
// ---------------------------------------------------------------------------

if (existsSync(CURSOR_DIST)) rmSync(CURSOR_DIST, { recursive: true });
mkdirSync(CURSOR_DIST, { recursive: true });

// beforeShellExecution handler
await build({
  entryPoints: [join(CURSOR_ROOT, "src/hook.ts")],
  outfile: join(CURSOR_DIST, "hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

// beforeReadFile + preToolUse(Edit|Write) multiplexed handler
await build({
  entryPoints: [join(CURSOR_ROOT, "src/file-hook.ts")],
  outfile: join(CURSOR_DIST, "file-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

// beforeSubmitPrompt handler — captures prompt context for next-call use
await build({
  entryPoints: [join(CURSOR_ROOT, "src/prompt-hook.ts")],
  outfile: join(CURSOR_DIST, "prompt-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

// Cursor adapter shares the same prompts/ as Claude Code
cpSync(join(ROOT, "prompts"), join(CURSOR_ROOT, "prompts"), { recursive: true });

// Mark cursor outputs executable too — they're published as npm `bin` entries.
makeExecutable(
  join(CURSOR_DIST, "hook.js"),
  join(CURSOR_DIST, "file-hook.js"),
  join(CURSOR_DIST, "prompt-hook.js"),
);

console.log(`[build] cursor shell hook     → ${CURSOR_DIST}/hook.js`);
console.log(`[build] cursor file hook      → ${CURSOR_DIST}/file-hook.js`);
console.log(`[build] cursor prompt hook    → ${CURSOR_DIST}/prompt-hook.js`);

// ---------------------------------------------------------------------------
// Antigravity (agy) adapter
// ---------------------------------------------------------------------------

if (existsSync(AGY_DIST)) rmSync(AGY_DIST, { recursive: true });
mkdirSync(AGY_DIST, { recursive: true });

// PreToolUse classifier
await build({
  entryPoints: [join(AGY_ROOT, "src/pretooluse-classify.ts")],
  outfile: join(AGY_DIST, "pretooluse-classify.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

makeExecutable(join(AGY_DIST, "pretooluse-classify.js"));

console.log(`[build] agy pretooluse hook   → ${AGY_DIST}/pretooluse-classify.js`);

// ---------------------------------------------------------------------------
// Codex adapter
// ---------------------------------------------------------------------------

if (existsSync(CODEX_DIST)) rmSync(CODEX_DIST, { recursive: true });
mkdirSync(CODEX_DIST, { recursive: true });

// PreToolUse classifier
await build({
  entryPoints: [join(CODEX_ROOT, "src/pretooluse-hook.ts")],
  outfile: join(CODEX_DIST, "pretooluse-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: SHEBANG },
});

// The core classifier reads prompts via `__dirname/../prompts/system.txt`.
// The bundled dist sits at adapters/codex/dist/, so copy prompts alongside.
cpSync(join(ROOT, "prompts"), join(CODEX_ROOT, "prompts"), { recursive: true });

makeExecutable(join(CODEX_DIST, "pretooluse-hook.js"));

console.log(`[build] codex pretooluse hook → ${CODEX_DIST}/pretooluse-hook.js`);
