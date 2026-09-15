import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyMcpCall,
  evaluateMcpPolicy,
  formatMcpAction,
  parseMcpToolName,
  parseOpenClawMcpToolName,
  redactMcpTranscript,
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

  test('normalises OpenClaw bundle tool names and leaves native names alone', () => {
    assert.deepEqual(parseOpenClawMcpToolName('github__get_issue'), {
      canonicalName: 'mcp__github__get_issue',
      server: 'github',
      tool: 'get_issue',
    });
    assert.equal(parseOpenClawMcpToolName('exec'), null);
    assert.equal(parseOpenClawMcpToolName('__missing_server'), null);
    assert.equal(parseOpenClawMcpToolName('missing_tool__'), null);
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

  test('redacts credentials in prior tool transcript inputs', () => {
    const redacted = redactMcpTranscript([
      {
        role: 'tool',
        name: 'mcp__example__read',
        input: JSON.stringify({ authorization: 'Bearer old-secret', nested: { token: 'old-token' }, safe: 42 }),
      },
      { role: 'tool', name: 'Bash', input: 'curl -H "Authorization: Bearer raw-secret" example.test' },
      { role: 'user', source: 'direct', text: 'keep user context' },
    ]);
    assert.deepEqual(JSON.parse(redacted[0].input!), {
      authorization: '[REDACTED]',
      nested: { token: '[REDACTED]' },
      safe: 42,
    });
    assert.doesNotMatch(redacted[1].input!, /raw-secret/);
    assert.equal(redacted[2].text, 'keep user context');
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

  test('shared path applies policy before the model and returns a redacted action', async () => {
    let calls = 0;
    const result = await classifyMcpCall({
      toolName: 'mcp__github__get_issue',
      toolInput: { token: 'secret', issue: 42 },
      transcript: [],
      modelCall: async () => {
        calls += 1;
        return 'BLOCK';
      },
      config: {
        ...DEFAULT_CONFIG,
        mcpAllowPatterns: ['^mcp__github__get_issue$'],
      },
    });
    assert.equal(result.result.decision, 'allow');
    assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(result.action).arguments, {
      token: '[REDACTED]',
      issue: 42,
    });
  });

  test('shared path never sends current or prior MCP credentials to the model', async () => {
    let modelInput = '';
    const result = await classifyMcpCall({
      toolName: 'mcp__github__create_issue',
      toolInput: { authorization: 'Bearer current-secret', title: 'safe title' },
      transcript: [{
        role: 'tool',
        name: 'mcp__github__get_issue',
        input: JSON.stringify({ token: 'prior-secret', issue: 42 }),
      }],
      modelCall: async (options) => {
        modelInput = options.messages[0].content;
        return 'ALLOW';
      },
      config: DEFAULT_CONFIG,
    });
    assert.equal(result.result.decision, 'allow');
    assert.doesNotMatch(modelInput, /current-secret|prior-secret/);
    assert.match(modelInput, /\[REDACTED\]/);
    assert.doesNotMatch(result.action, /current-secret/);
  });
});
