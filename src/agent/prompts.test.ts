import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildTurnPrompt,
  languageInstruction,
  loadProjectFileContents,
} from './prompts.js';

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

describe('per-turn project context', () => {
  it('keeps the current request, repository map, and relevant files together', () => {
    const prompt = buildTurnPrompt({
      request: 'Fix validateToken.',
      repositoryMap: 'src/auth.ts\n  symbols: validateToken',
      fileContents: [{ path: 'src/auth.ts', content: 'export function validateToken() {}' }],
      skippedFiles: ['src/large.ts'],
      initialVerification: { command: 'npm test', output: 'Expected 13, received 3' },
    });

    expect(prompt).toContain('Student request: Fix validateToken.');
    expect(prompt).toContain('Current repository structure');
    expect(prompt).toContain('symbols: validateToken');
    expect(prompt).toContain('=== src/auth.ts ===');
    expect(prompt).toContain('src/large.ts');
    expect(prompt).toContain('Initial verification failed before any changes');
    expect(prompt).toContain('Expected 13, received 3');
  });

  it('bounds failed file injection so large repositories cannot recreate an oversized prompt', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'minervacode-prompts-'));
    try {
      const paths: string[] = [];
      for (let i = 0; i < 50; i++) {
        const name = `large-${i}.txt`;
        paths.push(name);
        await writeFile(path.join(dir, name), 'x'.repeat(9 * 1024));
      }
      const result = await loadProjectFileContents(dir, paths);
      expect(result.files).toEqual([]);
      expect(result.skipped).toHaveLength(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
