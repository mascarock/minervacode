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
  projectContext?: string | null;
  projectFiles?: string[];
  fileContents?: ProjectFile[];
  /** Files that exist but were too big to inject. */
  skippedFiles?: string[];
}): string {
  const { projectDir, tools, projectContext, projectFiles, fileContents, skippedFiles } = options;

  const sections = [
    `Sei Minerva, un tutor di programmazione che aiuta uno studente direttamente nel terminale.
Lavori sui file REALI del progetto dello studente.

Directory di progetto: ${projectDir}`,
  ];

  if (projectContext) {
    sections.push(`Contesto del progetto (da ${PROJECT_CONTEXT_FILE}):\n${projectContext}`);
  }

  if (fileContents?.length) {
    const blocks = fileContents.map((f) => `=== ${f.path} ===\n${f.content}`).join('\n\n');
    sections.push(`Contenuto attuale dei file del progetto:\n\n${blocks}`);
  } else if (projectFiles?.length) {
    sections.push(
      `File nella directory di progetto (usa i tool per leggerli, non inventarne il contenuto):\n${projectFiles.join('\n')}`,
    );
  }

  if (skippedFiles?.length) {
    sections.push(
      `Altri file non mostrati per dimensione (leggili con il tool Read se servono):\n${skippedFiles.join('\n')}`,
    );
  }

  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

  sections.push(`Regole:
- Se proponi una modifica a un file, scrivi il NUOVO CONTENUTO COMPLETO del file in un blocco di codice preceduto dal nome del file (esempio: "Ecco \`utils.py\` corretto:"), così la CLI può applicarla dopo conferma dello studente.
- Spiega sempre brevemente cosa cambi e perché: lo studente deve capire.
- Non inventare MAI file o contenuti che non vedi qui.
- Rispondi in italiano.

Formato avanzato (se ti serve leggere altri file o eseguire comandi):
${toolList}

<minerva_tool name="Read">
<path>main.py</path>
</minerva_tool>

<minerva_tool name="Bash">
<command>python -m pytest</command>
</minerva_tool>

I risultati arrivano nel messaggio successivo come <tool_result>. Massimo 3 blocchi per risposta.`);

  return sections.join('\n\n');
}

export function formatToolResult(name: string, result: string, ok: boolean): string {
  const status = ok ? 'ok' : 'error';
  return `<tool_result name="${name}" status="${status}">\n${result}\n</tool_result>`;
}

export const PROJECT_CONTEXT_TEMPLATE = `# Contesto del progetto

Descrivi qui il tuo progetto per Minerva: cosa fa, come si esegue, cosa
stai studiando. Minerva legge questo file all'inizio di ogni sessione.

## Comandi

- Esegui: \`python main.py\`
- Test: \`python -m pytest\`

## Note

- (aggiungi qui vincoli o richieste del docente)
`;
