import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../tools/tool.js';
import { discoverProjectFiles, isSensitiveProjectFile } from './repo-map.js';

export const PROJECT_CONTEXT_FILE = '.minervacli.md';

const MAX_INJECT_FILES = 12;
const MAX_INJECT_CANDIDATES = 32;
const MAX_SKIPPED_REPORT = 20;
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
  let candidates = 0;

  for (const rel of paths) {
    if (rel.endsWith('/')) continue;
    if (isSensitiveProjectFile(rel)) {
      // Never echo secret filenames into model context either.
      continue;
    }
    if (files.length >= MAX_INJECT_FILES) {
      // Lower-ranked files are already represented in the token-budgeted
      // repository map. The skipped list is only for relevant candidates
      // that could not be injected because of their own contents/size.
      continue;
    }
    if (candidates >= MAX_INJECT_CANDIDATES) continue;
    candidates++;
    try {
      const content = await readFile(path.join(projectDir, rel), 'utf-8');
      if (
        content.includes('\0') ||
        content.length > MAX_INJECT_FILE_SIZE ||
        total + content.length > MAX_INJECT_TOTAL
      ) {
        if (skipped.length < MAX_SKIPPED_REPORT) skipped.push(rel);
        continue;
      }
      total += content.length;
      files.push({ path: rel, content });
    } catch {
      if (skipped.length < MAX_SKIPPED_REPORT) skipped.push(rel);
    }
  }

  return { files, skipped };
}

/** Full safe project listing, shared with the repository map and verifier. */
export async function listProjectFiles(projectDir: string): Promise<string[]> {
  return discoverProjectFiles(projectDir);
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
- Make the smallest source change that addresses the failing behavior. Preserve functions and tests that already pass; a focused bug fix must not rewrite unrelated working logic.
- Never invent files or file contents that you have not seen.
- Change only files required by the student's request. Do not rewrite package manifests, compiler configuration, or unrelated files unless the request specifically targets them.
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

export function buildTurnPrompt(options: {
  request: string;
  repositoryMap?: string;
  fileContents?: ProjectFile[];
  skippedFiles?: string[];
  initialVerification?: { command: string; output: string };
}): string {
  const sections = [`Student request: ${options.request}`];
  if (options.initialVerification) {
    sections.push(
      `Initial verification failed before any changes. Use this real failure as the primary diagnostic and fix the relevant SOURCE file:\n$ ${options.initialVerification.command}\n${options.initialVerification.output}`,
    );
  }
  if (options.repositoryMap) {
    sections.push(`Current repository structure:\n${options.repositoryMap}`);
  }
  if (options.fileContents?.length) {
    const blocks = options.fileContents
      .map((file) => `=== ${file.path} ===\n${file.content}`)
      .join('\n\n');
    sections.push(
      `Relevant current file contents (authoritative for this turn; use Read for anything omitted):\n\n${blocks}`,
    );
  }
  if (options.skippedFiles?.length) {
    sections.push(
      `Relevant files not injected because of size or safety limits (use Read when appropriate):\n${options.skippedFiles.join('\n')}`,
    );
  }
  return sections.join('\n\n');
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
