import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, languageInstruction } from './prompts.js';

describe('agent language prompt', () => {
  it('follows the request language by default', () => {
    expect(languageInstruction()).toContain('same language');
    expect(
      buildSystemPrompt({ projectDir: '/project', tools: [], language: 'auto' }),
    ).toContain("Reply in the same language as the student's latest request.");
  });

  it('supports explicit English and Italian replies', () => {
    expect(languageInstruction('en')).toBe('Reply in English.');
    expect(languageInstruction('it')).toBe('Reply in Italian.');
  });

  it('requires autonomous verification when enabled', () => {
    const prompt = buildSystemPrompt({
      projectDir: '/project',
      tools: [],
      autonomous: true,
    });
    expect(prompt).toContain('run the relevant tests');
    expect(prompt).toContain('Autonomous mode is enabled');
  });
});
