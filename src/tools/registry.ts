import type { Tool } from './tool.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { bashTool } from './bash.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';

const TOOLS: Tool[] = [
  readTool as Tool,
  globTool as Tool,
  grepTool as Tool,
  writeTool as Tool,
  editTool as Tool,
  bashTool as Tool,
];

export function getTools(): Tool[] {
  return TOOLS;
}

export function getTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase());
}
