import { describe, expect, it } from 'vitest';
import { needsApproval } from './permissions.js';
import { readTool } from '../tools/read.js';
import { globTool } from '../tools/glob.js';
import { grepTool } from '../tools/grep.js';
import { writeTool } from '../tools/write.js';
import { editTool } from '../tools/edit.js';
import { bashTool } from '../tools/bash.js';
import type { Tool } from '../tools/tool.js';

const asTool = (t: unknown) => t as Tool;

describe('needsApproval', () => {
  it('never asks for read-only tools', () => {
    for (const tool of [readTool, globTool, grepTool]) {
      expect(needsApproval(asTool(tool), 'default')).toBe(false);
      expect(needsApproval(asTool(tool), 'acceptEdits')).toBe(false);
      expect(needsApproval(asTool(tool), 'dontAsk')).toBe(false);
    }
  });

  it('asks for Write/Edit/Bash in default mode', () => {
    for (const tool of [writeTool, editTool, bashTool]) {
      expect(needsApproval(asTool(tool), 'default')).toBe(true);
    }
  });

  it('auto-allows Write/Edit but still asks for Bash in acceptEdits mode', () => {
    expect(needsApproval(asTool(writeTool), 'acceptEdits')).toBe(false);
    expect(needsApproval(asTool(editTool), 'acceptEdits')).toBe(false);
    expect(needsApproval(asTool(bashTool), 'acceptEdits')).toBe(true);
  });

  it('never asks in dontAsk mode', () => {
    for (const tool of [writeTool, editTool, bashTool]) {
      expect(needsApproval(asTool(tool), 'dontAsk')).toBe(false);
    }
  });
});
