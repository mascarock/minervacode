import type { PermissionMode } from './permissions.js';

export interface AgentSettings {
  projectDir: string;
  /** Full autonomous loop (--auto); assisted approval otherwise. */
  auto: boolean;
  permissionMode: PermissionMode;
}

export interface AppliedChange {
  path: string;
  /** Unified diff of what was applied. */
  patch: string;
}

/** Accumulates Write/Edit diffs across a session, backing the /diff command. */
export class ChangeLog {
  private changes: AppliedChange[] = [];

  add(change: AppliedChange): void {
    this.changes.push(change);
  }

  all(): AppliedChange[] {
    return [...this.changes];
  }

  get size(): number {
    return this.changes.length;
  }
}
