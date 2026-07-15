import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, parseReviewFindings } from './review.js';

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
