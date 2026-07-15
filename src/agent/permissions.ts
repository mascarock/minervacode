import type { Tool } from '../tools/tool.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'dontAsk'];

export function needsApproval(tool: Tool, mode: PermissionMode): boolean {
  if (tool.isReadOnly()) return false;
  if (mode === 'dontAsk') return false;
  if (mode === 'acceptEdits' && (tool.name === 'Write' || tool.name === 'Edit')) return false;
  return true;
}
