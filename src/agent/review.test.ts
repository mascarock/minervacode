import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelRequest } from '../model/index.js';
import { buildReviewPrompt, parseReviewFindings, runReviewWithModel } from './review.js';

/** No MinervaClient, no HTTP: only the ModelAdapter seam. */
function fakeModel(response: string, requests: ModelRequest[] = []): ModelAdapter {
  return {
    id: 'fake',
    model: 'fake-model',
    capabilities: { streaming: false, systemRole: true, toolCalls: false },
    async send(request) {
      requests.push(request);
      return response;
    },
  };
}

describe('parseReviewFindings', () => {
  it('parses bracketed findings with severities', () => {
    const text = `[BUG] calc.py — average divides by len - 1
- [WARN] calc.py — maximum crashes on empty list
[NIT] calc.py — missing docstring`;

    expect(parseReviewFindings(text)).toEqual([
      { severity: 'bug', text: 'calc.py — average divides by len - 1' },
      { severity: 'warn', text: 'calc.py — maximum crashes on empty list' },
      { severity: 'nit', text: 'calc.py — missing docstring' },
    ]);
  });

  it('accepts colon-separated tags and severity aliases', () => {
    const text = 'ERROR: broken import\nWarning: unused variable';
    expect(parseReviewFindings(text)).toEqual([
      { severity: 'bug', text: 'broken import' },
      { severity: 'warn', text: 'unused variable' },
    ]);
  });

  it('ignores prose that merely mentions a severity word', () => {
    const text = 'Bug fix: changed the divisor.\nThe warning about tests still applies.\nLGTM';
    expect(parseReviewFindings(text)).toEqual([]);
  });

  it('drops findings that echo the instruction template', () => {
    const text = `[BUG] file — what is wrong.
[BUG] <file> — <one sentence explaining what the new code wrongly does>
[BUG] utils.py — is_even returns True for odd numbers`;
    expect(parseReviewFindings(text)).toEqual([
      { severity: 'bug', text: 'utils.py — is_even returns True for odd numbers' },
    ]);
  });
});

describe('buildReviewPrompt', () => {
  it('embeds the diff and the reporting format', () => {
    const prompt = buildReviewPrompt('--- a/x.py\n+++ b/x.py\n+x = 1', 'en');
    expect(prompt).toContain('[BUG]');
    expect(prompt).toContain('LGTM');
    expect(prompt).toContain('+x = 1');
    expect(prompt).toContain('Reply in English.');
  });

  it('truncates very large diffs', () => {
    const prompt = buildReviewPrompt('x'.repeat(40 * 1024));
    expect(prompt).toContain('(diff truncated)');
    expect(prompt.length).toBeLessThan(30 * 1024);
  });
});

describe('runReviewWithModel', () => {
  it('reviews through the adapter and parses the findings', async () => {
    const requests: ModelRequest[] = [];
    const model = fakeModel('[BUG] calc.py — average divides by len - 1\n', requests);

    const result = await runReviewWithModel(model, {
      diff: '--- a/calc.py\n+++ b/calc.py\n+    return total / (len(xs) - 1)',
      language: 'en',
      intent: 'Fix the average function.',
    });

    expect(result.hasBugs).toBe(true);
    expect(result.findings).toEqual([
      { severity: 'bug', text: 'calc.py — average divides by len - 1' },
    ]);
    // Trimmed, so a trailing newline never reaches the student's transcript.
    expect(result.raw).toBe('[BUG] calc.py — average divides by len - 1');
  });

  it('sends one fresh user message carrying the prompt, diff, and intent', async () => {
    const requests: ModelRequest[] = [];
    const signal = new AbortController().signal;

    await runReviewWithModel(fakeModel('LGTM', requests), {
      diff: '+x = 1',
      language: 'en',
      intent: 'Set x to 1.',
      signal,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toHaveLength(1);
    const [message] = requests[0].messages;
    expect(message.role).toBe('user');
    expect(message.content).toContain("reviewing a student's code change");
    expect(message.content).toContain('+x = 1');
    expect(message.content).toContain('Set x to 1.');
    expect(requests[0].signal).toBe(signal);
  });

  it('reports a clean review with no findings', async () => {
    const result = await runReviewWithModel(fakeModel('Traced average(  [1,2] ) → 1.5. LGTM'), {
      diff: '+x = 1',
    });
    expect(result.findings).toEqual([]);
    expect(result.hasBugs).toBe(false);
  });
});
