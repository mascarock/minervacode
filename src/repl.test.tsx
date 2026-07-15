import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MinervaClient } from './api/client.js';
import { runChatOnce } from './repl.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function sseResponse(text: string): Response {
  const chunk = JSON.stringify({ choices: [{ delta: { content: text } }] });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 });
}

function mockClient(responses: string[]): MinervaClient {
  return {
    model: 'test-model',
    async postStream() {
      return sseResponse(responses.shift() ?? 'Done.');
    },
  } as MinervaClient;
}

describe('runChatOnce', () => {
  it('reverts the run and reports failure when verification never passes', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-once-'));
    dirs.push(projectDir);
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // The model "fixes" the file with a syntax error and never recovers.
    const client = mockClient(['Updated `calc.py`:\n\n```python\ndef broken(\n```']);

    const ok = await runChatOnce(client, 'Fix calc.py.', {
      projectDir,
      auto: true,
      language: 'en',
    });

    expect(ok).toBe(false);
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 1\n');
  });

  it('rollback also removes an EMPTY file the failed run created', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-once-'));
    dirs.push(projectDir);
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // One turn: a broken source edit plus a brand-new empty __init__.py.
    const client = mockClient([
      '<minerva_tool name="Write">\n<path>calc.py</path>\n<content>\ndef broken(\n</content>\n</minerva_tool>\n' +
        '<minerva_tool name="Write">\n<path>__init__.py</path>\n<content>\n</content>\n</minerva_tool>',
    ]);

    const ok = await runChatOnce(client, 'Fix calc.py and make it a package.', {
      projectDir,
      auto: true,
      language: 'en',
    });

    expect(ok).toBe(false);
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 1\n');
    expect(existsSync(path.join(projectDir, '__init__.py'))).toBe(false);
  });

  it('reverts on turn-limit even when checks passed along the way', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-once-'));
    dirs.push(projectDir);
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // The model never stops emitting writes, so the run hits MAX_TURNS.
    let turn = 0;
    const client = {
      model: 'test-model',
      async postStream() {
        turn++;
        return sseResponse(`Updated \`calc.py\`:\n\n\`\`\`python\nx = ${turn + 1}\n\`\`\``);
      },
    } as MinervaClient;

    const ok = await runChatOnce(client, 'Keep counting.', {
      projectDir,
      auto: true,
      language: 'en',
    });

    expect(ok).toBe(false);
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 1\n');
  });

  it('treats a completed run with no applicable verifier as success', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-once-'));
    dirs.push(projectDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const client = mockClient([
      'Updated `NOTES.md`:\n\n```\nhello world\n```',
      'Done.',
      'LGTM',
    ]);

    const ok = await runChatOnce(client, 'Write a note.', {
      projectDir,
      auto: true,
      language: 'en',
    });

    expect(ok).toBe(true);
    expect(await readFile(path.join(projectDir, 'NOTES.md'), 'utf-8')).toBe('hello world\n');
  });

  it('returns true for a verified run and keeps the changes', async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'minervacli-once-'));
    dirs.push(projectDir);
    await writeFile(path.join(projectDir, 'calc.py'), 'x = 1\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const client = mockClient([
      'Updated `calc.py`:\n\n```python\nx = 2\n```',
      'Done.',
      'LGTM',
    ]);

    const ok = await runChatOnce(client, 'Set x to 2.', {
      projectDir,
      auto: true,
      language: 'en',
    });

    expect(ok).toBe(true);
    expect(await readFile(path.join(projectDir, 'calc.py'), 'utf-8')).toBe('x = 2\n');
  });
});
