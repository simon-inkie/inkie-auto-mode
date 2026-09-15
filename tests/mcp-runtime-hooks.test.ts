import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const CLAUDE_HOOK = resolve(ROOT, 'adapters/claude-code/src/hook.ts');
const CURSOR_HOOK = resolve(ROOT, 'adapters/cursor/src/hook.ts');

const cfgDir = mkdtempSync(join(tmpdir(), 'mcp-runtime-config-'));
const cfgPath = join(cfgDir, 'config.json');
writeFileSync(cfgPath, JSON.stringify({
  mode: 'classify',
  mcpAllowPatterns: ['^mcp__example__read$'],
  mcpBlockPatterns: ['^mcp__example__delete$'],
}));

function invoke(hook: string, payload: unknown, home: string) {
  return spawnSync(TSX, [hook], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, IO_AUTO_MODE_CONFIG: cfgPath },
  });
}

function invokeWithConfig(hook: string, payload: unknown, home: string, configPath: string) {
  return spawnSync(TSX, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, IO_AUTO_MODE_CONFIG: configPath },
  });
}

describe('Claude Code MCP PreToolUse wire contract', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-mcp-home-'));

  test('allow and block policies map to Claude permission decisions', () => {
    for (const [tool, expected] of [['mcp__example__read', 'allow'], ['mcp__example__delete', 'deny']]) {
      const result = invoke(CLAUDE_HOOK, {
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: { token: 'secret', issue: 42 },
      }, home);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, expected);
    }
  });

  test('ledger stores redacted arguments', () => {
    const result = invoke(CLAUDE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__example__read',
      tool_input: { apiKey: 'secret', safe: 'kept' },
    }, home);
    assert.equal(result.status, 0, result.stderr);
    const ledger = join(home, '.io-auto-mode', 'auto-mode-log.jsonl');
    const entry = JSON.parse(readFileSync(ledger, 'utf-8').trim().split('\n').pop()!);
    assert.equal(JSON.parse(entry.command).arguments.apiKey, '[REDACTED]');
    assert.equal(entry.adapter, 'claude-code');
  });

  test('malformed explicit configuration fails closed', () => {
    const broken = join(home, 'broken-config.json');
    writeFileSync(broken, '{bad json');
    const result = invokeWithConfig(CLAUDE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__example__read',
      tool_input: {},
    }, home, broken);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('Cursor beforeMCPExecution wire contract', () => {
  const home = mkdtempSync(join(tmpdir(), 'cursor-mcp-home-'));

  const payload = (tool: string, toolInput: string = '{}') => ({
    hook_event_name: 'beforeMCPExecution',
    mcp_server_name: 'example',
    tool_name: tool,
    tool_input: toolInput,
    conversation_id: 'test-conversation',
  });

  test('allow and block policies map to Cursor permissions', () => {
    for (const [tool, expected] of [['read', 'allow'], ['delete', 'deny']]) {
      const result = invoke(CURSOR_HOOK, payload(tool, JSON.stringify({ token: 'secret' })), home);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).permission, expected);
    }
  });

  test('missing server identity and malformed tool_input fail closed', () => {
    const missing = invoke(CURSOR_HOOK, {
      hook_event_name: 'beforeMCPExecution',
      tool_name: 'read',
      tool_input: '{}',
    }, home);
    assert.equal(JSON.parse(missing.stdout).permission, 'deny');

    const malformed = invoke(CURSOR_HOOK, payload('read', '{bad json'), home);
    assert.equal(JSON.parse(malformed.stdout).permission, 'deny');
  });

  test('ledger stores redacted arguments', () => {
    const result = invoke(CURSOR_HOOK, payload('read', JSON.stringify({ password: 'secret', safe: true })), home);
    assert.equal(result.status, 0, result.stderr);
    const ledger = join(home, '.io-auto-mode', 'auto-mode-log.jsonl');
    const entry = JSON.parse(readFileSync(ledger, 'utf-8').trim().split('\n').pop()!);
    assert.equal(JSON.parse(entry.command).arguments.password, '[REDACTED]');
    assert.equal(entry.adapter, 'cursor');
  });

  test('malformed explicit configuration fails closed', () => {
    const broken = join(home, 'broken-config.json');
    writeFileSync(broken, '{bad json');
    const result = invokeWithConfig(CURSOR_HOOK, payload('read'), home, broken);
    assert.equal(JSON.parse(result.stdout).permission, 'deny');
  });
});
