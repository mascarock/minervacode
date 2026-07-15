import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, resolveInProject } from '../tools/tool.js';

/** Net effect of an agent run on one file: first-seen and final contents. */
export interface NetChange {
  path: string;
  before: string;
  after: string;
  /** Whether the file existed before the run first touched it. */
  existedBefore: boolean;
}

/**
 * Restores the files an agent run changed to their pre-run contents. Only
 * files in `changes` are touched, and `before` was captured at the run's
 * first write, so pre-existing user edits are preserved inside it. Files
 * the run created are removed; a pre-existing file is always restored —
 * even when it was empty. Returns the paths actually reverted.
 */
export async function revertNetChanges(
  projectDir: string,
  changes: NetChange[],
): Promise<string[]> {
  const reverted: string[] = [];
  for (const change of changes) {
    if (change.before === change.after && change.existedBefore) continue;
    try {
      const file = resolveInProject(projectDir, change.path);
      if (!change.existedBefore) {
        await rm(file, { force: true });
      } else {
        await mkdir(path.dirname(file), { recursive: true });
        await atomicWriteFile(file, change.before);
      }
      reverted.push(change.path);
    } catch {
      // leave the file as-is; only successful reverts are reported
    }
  }
  return reverted;
}
