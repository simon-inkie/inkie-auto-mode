import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  evaluateMcpPolicy,
  formatMcpAction,
  parseMcpToolName,
} from '../core/mcp.js';
import { classify } from '../core/classifier.js';
import { DEFAULT_CONFIG } from '../core/types.js';

describe('MCP tool identity', () => {
  test('parses canonical Codex MCP names', () => {
    assert.deepEqual(parseMcpToolName('mcp__apify__call_actor'), {
      canonicalName: 'mcp__apify__call_actor',
      server: 'apify',
      tool: 'call_actor',
    });
  });

  test('rejects non-MCP and malformed names', () => {
    assert.equal(parseMcpToolName('Bash'), null);
    assert.equal(parseMcpToolName('mcp__missing_tool'), null);
    assert.equal(parseMcpToolName('mcp____tool'), null);
  });
});

describe('MCP action formatting', () => {
  const identity = parseMcpToolName('mcp__example__write')!;

  test('redacts secret keys, auth values and URL credentials recursively', () => {
    const action = JSON.parse(formatMcpAction(identity, {
      apiKey: 'top-secret',
      nested: { authorization: 'Bearer abc.def', safe: 'keep me' },
      header: 'Bearer abc123',
      command: 'curl https://alice:hunter2@example.test token=abc123',
    }));
    assert.equal(action.arguments.apiKey, '[REDACTED]');
    assert.equal(action.arguments.nested.authorization, '[REDACTED]');
    assert.equal(action.arguments.nested.safe, 'keep me');
    assert.equal(action.arguments.header, 'Bearer [REDACTED]');
    assert.equal(
      action.arguments.command,
      'curl https://[REDACTED]@example.test token=[REDACTED]',
    );
  });

  test('caps oversized arguments while keeping valid JSON', () => {
    const action = JSON.parse(formatMcpAction(identity, { text: 'x'.repeat(20_000) }));
    assert.equal(action.truncated, true);
    assert.match(action.argumentsPreview, /\[TRUNCATED\]$/);
  });
});

describe('MCP server/tool policy', () => {
  const identity = parseMcpToolName('mcp__github__get_issue')!;

  test('block patterns take precedence over allow patterns', () => {
    const result = evaluateMcpPolicy(identity, {
      ...DEFAULT_CONFIG,
      mcpAllowPatterns: ['^mcp__github__'],
      mcpBlockPatterns: ['get_issue$'],
    });
    assert.equal(result?.decision, 'block');
  });

  test('allow patterns resolve without a model call', () => {
    const result = evaluateMcpPolicy(identity, {
      ...DEFAULT_CONFIG,
      mcpAllowPatterns: ['^mcp__github__get_'],
    });
    assert.equal(result?.decision, 'allow');
  });

  test('invalid and unmatched patterns fall through', () => {
    const result = evaluateMcpPolicy(identity, {
      ...DEFAULT_CONFIG,
      mcpAllowPatterns: ['[', '^mcp__apify__'],
    });
    assert.equal(result, null);
  });
});

describe('MCP model classification', () => {
  test('does not apply shell static patterns to MCP argument content', async () => {
    let calls = 0;
    const result = await classify(
      '{"server":"posts","tool":"create","arguments":{"text":"example: rm -rf /"}}',
      [],
      async (options) => {
        calls += 1;
        assert.match(options.system, /Model Context Protocol/);
        assert.doesNotMatch(options.system, /shell command execution/);
        return 'ALLOW';
      },
      DEFAULT_CONFIG,
      { actionKind: 'mcp' },
    );
    assert.equal(result.decision, 'allow');
    assert.equal(result.stage, 'stage1');
    assert.equal(calls, 1);
  });
});
