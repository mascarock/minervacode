import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildTurnPrompt,
  formatWebResults,
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

describe('web results injection', () => {
  const results = [
    { title: 'Node 26', url: 'https://nodejs.org/v26', snippet: 'Version 26 is Current.' },
    { title: 'Docs', url: 'https://nodejs.org/docs', snippet: 'Reference material.' },
  ];

  it('formats results as compact numbered lines with a citation instruction', () => {
    const block = formatWebResults('latest node?', results);
    expect(block).toContain('Current web results for "latest node?"');
    expect(block).toContain('cite the [n] you use');
    expect(block).toContain('[1] Node 26 — https://nodejs.org/v26');
    expect(block).toContain('[2] Docs — https://nodejs.org/docs');
    expect(block).toContain('Version 26 is Current.');
  });

  it('caps snippet length so a small model is not swamped', () => {
    const long = 'x'.repeat(500);
    const block = formatWebResults('q', [{ title: 'T', url: 'https://e/1', snippet: long }]);
    // The snippet must be trimmed well below its original length.
    const snippetLine = block.split('\n').find((l) => l.startsWith('x'))!;
    expect(snippetLine.length).toBeLessThanOrEqual(200);
  });

  it('collapses whitespace in snippets to single lines', () => {
    const block = formatWebResults('q', [
      { title: 'T', url: 'https://e/1', snippet: 'a\n\n  b\t c' },
    ]);
    expect(block).toContain('a b c');
  });

  it('injects the web block into the turn prompt, right after the request', () => {
    const prompt = buildTurnPrompt({
      request: 'What is new in Node?',
      repositoryMap: 'src/index.ts',
      webSearch: { query: 'What is new in Node?', results },
    });
    expect(prompt).toContain('https://nodejs.org/v26');
    // Web facts precede the repository map so they stay salient for the 7B.
    expect(prompt.indexOf('Current web results')).toBeLessThan(
      prompt.indexOf('Current repository structure'),
    );
    expect(prompt.indexOf('Student request:')).toBeLessThan(prompt.indexOf('Current web results'));
  });

  it('omits the web section entirely when there are no results', () => {
    const prompt = buildTurnPrompt({
      request: 'Fix the bug.',
      webSearch: { query: 'Fix the bug.', results: [] },
    });
    expect(prompt).not.toContain('Current web results');
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
