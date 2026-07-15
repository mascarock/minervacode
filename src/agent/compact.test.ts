import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types.js';
import {
  compactMessages,
  estimateTextTokens,
  formatContextStats,
  getContextStats,
} from './compact.js';

const message = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

describe('context compaction', () => {
  it('returns untouched history while it is inside the budget', () => {
    const messages = [message('user', 'stable instructions'), message('assistant', 'Hello')];
    const result = compactMessages(messages, { maxEstimatedTokens: 100 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.after).toEqual(result.before);
  });

  it('omits old successful tool output but preserves bootstrap and recent turns', () => {
    const bootstrap = 'STABLE RULES ' + 'r'.repeat(500);
    const oldOutput = 'x'.repeat(5_000);
    const recent = 'LATEST RESULT ' + 'y'.repeat(500);
    const messages = [
      message('user', bootstrap),
      message('assistant', '<minerva_tool name="Read"><path>old.ts</path></minerva_tool>'),
      message('user', `<tool_result name="Read" status="ok">\n${oldOutput}\n</tool_result>`),
      message('assistant', 'Older response'),
      message('user', 'Another turn'),
      message('assistant', recent),
    ];

    const result = compactMessages(messages, {
      maxEstimatedTokens: 700,
      keepRecentMessages: 2,
    });

    expect(result.messages[0].content).toBe(bootstrap);
    expect(result.messages.at(-1)?.content).toBe(recent);
    expect(result.messages[2].content).toContain('Older successful Read result omitted');
    expect(result.messages[2].content).not.toContain(oldOutput);
    expect(result.after.estimatedTokens).toBeLessThan(result.before.estimatedTokens);
  });

  it('keeps the shape and useful edges of older errors', () => {
    const error = `first failure\n${'trace\n'.repeat(1_000)}last failure`;
    const messages = [
      message('user', 'rules'),
      message('assistant', 'command'),
      message('user', `<tool_result name="Bash" status="error">\n${error}\n</tool_result>`),
      message('assistant', 'considering fix'),
      message('user', 'continue'),
      message('assistant', 'latest'),
    ];
    const result = compactMessages(messages, {
      maxEstimatedTokens: 800,
      keepRecentMessages: 2,
    });

    expect(result.messages[2].content).toContain('status="error"');
    expect(result.messages[2].content).toContain('first failure');
    expect(result.messages[2].content).toContain('last failure');
    expect(result.messages[2].content).toContain('omitted from older error output');
  });

  it('removes old complete-file proposals and retains their filename context', () => {
    const messages = [
      message('user', 'rules'),
      message('assistant', `Updated \`src/app.ts\`:\n\n\`\`\`ts\n${'const value = 1;\n'.repeat(500)}\`\`\``),
      message('user', 'tool result'),
      message('assistant', 'middle'),
      message('user', 'new request'),
      message('assistant', 'latest'),
    ];
    const result = compactMessages(messages, {
      maxEstimatedTokens: 500,
      keepRecentMessages: 2,
    });

    expect(result.messages[1].content).toContain('src/app.ts');
    expect(result.messages[1].content).toContain('Older code proposal omitted');
    expect(result.messages[1].content).not.toContain('const value = 1');
  });

  it('reports estimated utilization for the REPL', () => {
    const stats = getContextStats([message('user', 'x'.repeat(400))], 200);
    expect(estimateTextTokens('x'.repeat(40))).toBe(10);
    expect(stats.estimatedTokens).toBe(104);
    expect(formatContextStats(stats)).toContain('104 / 200 input tokens (52%)');
  });
});
