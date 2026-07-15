import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../tools/tool.js';

export const PROJECT_CONTEXT_FILE = '.minervacli.md';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__', '.venv', 'venv']);
const MAX_LISTING = 50;

const MAX_INJECT_FILES = 12;
const MAX_INJECT_FILE_SIZE = 8 * 1024;
const MAX_INJECT_TOTAL = 32 * 1024;

export interface ProjectFile {
  path: string;
  content: string;
}

export type AgentLanguage = 'auto' | 'en' | 'it';

export const AGENT_LANGUAGES: AgentLanguage[] = ['auto', 'en', 'it'];

export function languageInstruction(language: AgentLanguage = 'auto'): string {
  if (language === 'it') return 'Reply in Italian.';
  if (language === 'en') return 'Reply in English.';
  return "Reply in the same language as the student's latest request.";
}

/**
 * Loads small text files for direct context injection. ChatMinerva (7B)
 * does not reliably emit Read tool calls, so for homework-sized projects
 * the file contents ride along in the first message instead.
 */
export async function loadProjectFileContents(
  projectDir: string,
  paths: string[],
): Promise<{ files: ProjectFile[]; skipped: string[] }> {
  const files: ProjectFile[] = [];
  const skipped: string[] = [];
  let total = 0;

  for (const rel of paths) {
    if (rel.endsWith('/')) continue;
    if (files.length >= MAX_INJECT_FILES) {
      skipped.push(rel);
      continue;
    }
    try {
      const content = await readFile(path.join(projectDir, rel), 'utf-8');
      if (
        content.includes('\0') ||
        content.length > MAX_INJECT_FILE_SIZE ||
        total + content.length > MAX_INJECT_TOTAL
      ) {
        skipped.push(rel);
        continue;
      }
      total += content.length;
      files.push({ path: rel, content });
    } catch {
      skipped.push(rel);
    }
  }

  return { files, skipped };
}

/** Shallow two-level listing so the model sees real file names up front. */
export async function listProjectFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const top = await readdir(projectDir, { withFileTypes: true });
    for (const entry of top) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (out.length >= MAX_LISTING) break;
      if (entry.isDirectory()) {
        out.push(`${entry.name}/`);
        try {
          const nested = await readdir(path.join(projectDir, entry.name));
          for (const name of nested) {
            if (out.length >= MAX_LISTING) break;
            if (!name.startsWith('.')) out.push(`${entry.name}/${name}`);
          }
        } catch {
          // unreadable subdirectory — top-level entry is enough
        }
      } else {
        out.push(entry.name);
      }
    }
  } catch {
    // unreadable project dir — the model can still use Glob
  }
  return out;
}

export async function loadProjectContext(projectDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(projectDir, PROJECT_CONTEXT_FILE), 'utf-8');
    return text.trim() || null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(options: {
  projectDir: string;
  tools: Tool[];
  language?: AgentLanguage;
  autonomous?: boolean;
  projectContext?: string | null;
  projectFiles?: string[];
  fileContents?: ProjectFile[];
  /** Files that exist but were too big to inject. */
  skippedFiles?: string[];
}): string {
  const {
    projectDir,
    tools,
    language = 'auto',
    autonomous = false,
    projectContext,
    projectFiles,
    fileContents,
    skippedFiles,
  } = options;

  const languageRule = languageInstruction(language);

  const sections = [
    `You are Minerva, a programming agent helping a student directly in the terminal.
You work on the student's REAL project files.

Project directory: ${projectDir}`,
  ];

  if (projectContext) {
    sections.push(`Project context (from ${PROJECT_CONTEXT_FILE}):\n${projectContext}`);
  }

  if (fileContents?.length) {
    const blocks = fileContents.map((f) => `=== ${f.path} ===\n${f.content}`).join('\n\n');
    sections.push(`Current project file contents:\n\n${blocks}`);
  } else if (projectFiles?.length) {
    sections.push(
      `Files in the project directory (use tools to read them; never invent their contents):\n${projectFiles.join('\n')}`,
    );
  }

  if (skippedFiles?.length) {
    sections.push(
      `Other files omitted because of their size (read them with Read when needed):\n${skippedFiles.join('\n')}`,
    );
  }

  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

  sections.push(`Rules:
- ${languageRule}
- Act on coding requests instead of only describing suggested steps. Inspect the relevant files, make the requested changes, and verify the result.
- Use the tools below to read files, edit files, and run shell commands. Do not ask the student to run a command that you can run yourself.
- After changing code, run the relevant tests, build, typecheck, or lint command. If verification fails, diagnose the output, fix the issue, and run it again.
- Never invent files or file contents that you have not seen.
- Never rewrite or weaken tests to make them pass — fix the source code instead. Only modify test files when the student explicitly asks for it.
- Briefly explain what you changed and why so the student can learn. Highlight the important concepts in **bold**.
${autonomous ? '- Autonomous mode is enabled: proceed with necessary file changes and commands without asking for confirmation.' : '- Approval mode is enabled: the CLI will request confirmation before potentially modifying operations.'}
- If you cannot emit a structured Write or Edit call, write the COMPLETE new file contents in a fenced code block with the filename on its own line immediately BEFORE the fence (example: "Updated \`utils.py\`:"). One file per code block; never put the filename only inside the block. The CLI applies this fallback.
- Run shell commands only through the Bash tool block — a plain \`\`\`bash code block is NOT executed.

Tool-call format:
${toolList}

<minerva_tool name="Read">
<path>main.py</path>
</minerva_tool>

<minerva_tool name="Bash">
<command>python -m pytest</command>
</minerva_tool>

Tool results arrive in the next message as <tool_result>. Emit at most 3 tool blocks per response.`);

  return sections.join('\n\n');
}

export function formatToolResult(name: string, result: string, ok: boolean): string {
  const status = ok ? 'ok' : 'error';
  return `<tool_result name="${name}" status="${status}">\n${result}\n</tool_result>`;
}

export const PROJECT_CONTEXT_TEMPLATE = `# Project context

Describe your project for Minerva: what it does, how to run it, and what
you are studying. Minerva reads this file at the start of every session.

## Commands

- Run: \`python main.py\`
- Test: \`python -m pytest\`

## Note

- (add any constraints or requirements here)
`;
