import { readFile } from 'node:fs/promises';
import { createPatch } from 'diff';
import { resolveInProject } from '../tools/tool.js';

export async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

function cleanPatch(patch: string): string {
  // Drop the "Index:" header block createPatch prepends.
  return patch.split('\n').filter((l) => !l.startsWith('Index:') && !/^=+$/.test(l)).join('\n').trim();
}

export function filePatch(path: string, before: string, after: string): string {
  return cleanPatch(createPatch(path, before, after));
}

/**
 * Builds the human preview shown before approving a tool call: a unified
 * diff for Write/Edit, the command line for Bash, raw args otherwise.
 */
export async function buildPreview(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string,
): Promise<string> {
  if (toolName === 'Write') {
    const path = String(input.path ?? '');
    const before = await readIfExists(resolveInProject(projectDir, path));
    return filePatch(path, before, String(input.content ?? ''));
  }

  if (toolName === 'Edit') {
    const path = String(input.path ?? '');
    const before = await readIfExists(resolveInProject(projectDir, path));
    const oldString = String(input.old_string ?? '');
    const index = before.indexOf(oldString);
    if (index === -1) {
      return `old_string not found in ${path} — the call will fail`;
    }
    const after =
      before.slice(0, index) + String(input.new_string ?? '') + before.slice(index + oldString.length);
    return filePatch(path, before, after);
  }

  if (toolName === 'Bash') {
    return `$ ${String(input.command ?? '')}`;
  }

  return JSON.stringify(input, null, 2);
}
