import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'io-auto-mode-built-mcp-'));
const config = join(temp, 'config.json');
writeFileSync(config, JSON.stringify({
  mode: 'classify',
  mcpAllowPatterns: ['^mcp__example__read$'],
}));

const result = spawnSync(
  process.execPath,
  [resolve(root, 'adapters/antigravity/dist/pretooluse-classify.js')],
  {
    input: JSON.stringify({
      conversationId: 'built-smoke',
      toolCall: { name: 'mcp__example__read', args: { token: 'secret' } },
      workspacePaths: [root],
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: temp, IO_AUTO_MODE_CONFIG: config },
  },
);

if (result.status !== 0) {
  throw new Error(`Built Antigravity hook exited ${result.status}: ${result.stderr}`);
}
const output = JSON.parse(result.stdout);
if (output.allowTool !== true || Object.keys(output).length !== 1) {
  throw new Error(`Unexpected built Antigravity hook output: ${result.stdout}`);
}
console.log('[smoke] built Antigravity MCP hook loaded prompt assets and allowed policy match');
