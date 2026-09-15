/**
 * Tests for the Antigravity (agy) PreToolUse classifier.
 *
 * Exercises the exported run() function directly -- no subprocess or LLM calls.
 * All classify() paths that would hit a model are for run_command; safe
 * no-model paths (allow-tools, unknown-tool, empty CommandLine) are tested here.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { run } from '../adapters/antigravity/src/pretooluse-classify.js';
import { DEFAULT_CONFIG } from '../core/types.js';
import type { ClassifierDecision } from '../core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(toolName: string, args: Record<string, unknown> = {}, conversationId = 'test-conv'): string {
  return JSON.stringify({
    conversationId,
    toolCall: { name: toolName, args },
    workspacePaths: ['/tmp'],
  });
}

// ---------------------------------------------------------------------------
// Infra / parse errors -- fail-open
// ---------------------------------------------------------------------------

describe('antigravity-classify: infra errors fail-open', () => {
  test('empty string returns allowTool:true', async () => {
    const result = await run('');
    assert.equal(result.allowTool, true);
  });

  test('invalid JSON returns allowTool:true', async () => {
    const result = await run('not valid json {{{');
    assert.equal(result.allowTool, true);
  });

  test('null body returns allowTool:true', async () => {
    const result = await run('null');
    // null parsed -> toolCall undefined -> ALLOW_TOOLS miss -> unknown-tool -> allow
    assert.equal(result.allowTool, true);
  });
});

// ---------------------------------------------------------------------------
// Read-only / agy-internal tools -- always allow
// ---------------------------------------------------------------------------

describe('antigravity-classify: read-only tools always allow', () => {
  const readOnlyTools = [
    'view_file',
    'list_dir',
    'read_url_content',
    'search_web',
    'grep_search',
    'codebase_search',
    'find_filepath',
  ];

  for (const tool of readOnlyTools) {
    test(`${tool} returns allowTool:true`, async () => {
      const result = await run(makeInput(tool));
      assert.equal(result.allowTool, true, `${tool} should always be allowed`);
    });
  }
});

describe('antigravity-classify: agy-internal tools always allow', () => {
  const internalTools = [
    'ask_permission',
    'ask_question',
    'list_permissions',
    'invoke_subagent',
  ];

  for (const tool of internalTools) {
    test(`${tool} returns allowTool:true`, async () => {
      const result = await run(makeInput(tool));
      assert.equal(result.allowTool, true, `${tool} should always be allowed`);
    });
  }
});

// ---------------------------------------------------------------------------
// run_command with empty / missing CommandLine -- allow
// ---------------------------------------------------------------------------

describe('antigravity-classify: run_command with empty CommandLine fails-open', () => {
  test('empty CommandLine string returns allowTool:true', async () => {
    const result = await run(makeInput('run_command', { CommandLine: '' }));
    assert.equal(result.allowTool, true);
  });

  test('whitespace-only CommandLine returns allowTool:true', async () => {
    const result = await run(makeInput('run_command', { CommandLine: '   ' }));
    assert.equal(result.allowTool, true);
  });

  test('missing CommandLine field returns allowTool:true', async () => {
    const result = await run(makeInput('run_command', {}));
    assert.equal(result.allowTool, true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tools -- allow + log (no classify call)
// ---------------------------------------------------------------------------

describe('antigravity-classify: unknown tools allow + log', () => {
  test('unrecognised tool name returns allowTool:true', async () => {
    const result = await run(makeInput('some_future_tool'));
    assert.equal(result.allowTool, true);
  });

  test('empty tool name returns allowTool:true', async () => {
    const result = await run(JSON.stringify({ conversationId: 'c', workspacePaths: [] }));
    // no toolCall -> toolName="" -> not in ALLOW_TOOLS -> not run_command -> unknown -> allow
    assert.equal(result.allowTool, true);
  });
});

// ---------------------------------------------------------------------------
// Canonical MCP tools -- static/model classification and fail-closed errors
// ---------------------------------------------------------------------------

describe('antigravity-classify: MCP tools', () => {
  const decision = (value: ClassifierDecision['decision']) => async () => ({
    decision: value,
    stage: 'stage1' as const,
    durationMs: 1,
  });

  test('allow maps to allowTool:true; ask and block map to false', async () => {
    for (const [value, expected] of [['allow', true], ['ask', false], ['block', false]] as const) {
      const result = await run(makeInput('mcp__github__get_issue', { issue: 42 }), {
        classifyFn: decision(value),
        loadConfigFn: () => DEFAULT_CONFIG,
      });
      assert.equal(result.allowTool, expected, value);
      assert.deepEqual(Object.keys(result), ['allowTool']);
    }
  });

  test('allow policy bypasses model classification', async () => {
    let calls = 0;
    const result = await run(makeInput('mcp__github__get_issue'), {
      classifyFn: async () => {
        calls += 1;
        return { decision: 'block', stage: 'stage1', durationMs: 1 };
      },
      loadConfigFn: () => ({
        ...DEFAULT_CONFIG,
        mcpAllowPatterns: ['^mcp__github__get_issue$'],
      }),
    });
    assert.equal(result.allowTool, true);
    assert.equal(calls, 0);
  });

  test('ledger receives the redacted action and adapter identity', async () => {
    const calls: unknown[][] = [];
    await run(makeInput('mcp__github__get_issue', { apiKey: 'secret', issue: 42 }), {
      classifyFn: decision('allow'),
      loadConfigFn: () => DEFAULT_CONFIG,
      logDecisionFn: ((...args: unknown[]) => calls.push(args)) as never,
    });
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][0] as string).arguments.apiKey, '[REDACTED]');
    assert.deepEqual(calls[0][3], { adapter: 'antigravity' });
  });

  test('MCP config and classifier failures fail closed', async () => {
    const configFailure = await run(makeInput('mcp__github__get_issue'), {
      loadConfigFn: () => { throw new Error('config unavailable'); },
    });
    assert.equal(configFailure.allowTool, false);

    const classifierFailure = await run(makeInput('mcp__github__get_issue'), {
      loadConfigFn: () => DEFAULT_CONFIG,
      classifyFn: async () => { throw new Error('classifier unavailable'); },
    });
    assert.equal(classifierFailure.allowTool, false);
  });
});

// ---------------------------------------------------------------------------
// Output shape contract -- MUST be exactly { allowTool: boolean }
// ---------------------------------------------------------------------------

describe('antigravity-classify: output shape is exactly {allowTool:bool}', () => {
  test('allowTool:true result has no extra fields', async () => {
    const result = await run(makeInput('view_file'));
    const keys = Object.keys(result);
    assert.deepEqual(keys, ['allowTool'], 'must emit only allowTool');
    assert.equal(typeof result.allowTool, 'boolean');
  });

  test('fail-open on parse error has no extra fields', async () => {
    const result = await run('bad json');
    const keys = Object.keys(result);
    assert.deepEqual(keys, ['allowTool'], 'fail-open must emit only allowTool');
  });
});
