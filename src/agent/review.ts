import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MinervaClient } from '../api/client.js';
import { streamChat } from '../api/chat.js';
import type { ChatMessage } from '../types.js';
import { filePatch } from './preview.js';
import { languageInstruction, type AgentLanguage } from './prompts.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 24 * 1024;

export type ReviewSeverity = 'bug' | 'warn' | 'nit';

export interface ReviewFinding {
  severity: ReviewSeverity;
  text: string;
}

export interface ReviewResult {
  /** Full reviewer response, shown to the student. */
  raw: string;
  findings: ReviewFinding[];
  /** True when the review flagged at least one BUG-level finding. */
  hasBugs: boolean;
}

// A finding needs either a bracketed tag or a tag followed by a separator,
// so prose like "Bug fix: …" does not count.
const FINDING_LINE =
  /^\s*[-*]?\s*(?:\[(BUG|BLOCKER|ERROR|WARN|WARNING|NIT|STYLE|MINOR)\]|(BUG|BLOCKER|ERROR|WARN|WARNING|NIT|STYLE|MINOR)\s*[:—–-])\s*(.+)$/i;

const SEVERITY_MAP: Record<string, ReviewSeverity> = {
  bug: 'bug',
  blocker: 'bug',
  error: 'bug',
  warn: 'warn',
  warning: 'warn',
  nit: 'nit',
  style: 'nit',
  minor: 'nit',
};

/**
 * Weak models sometimes copy the finding format from the instructions
 * verbatim instead of filling it in. Such echoes carry no information and
 * must not trigger fix cycles.
 */
const TEMPLATE_ECHO =
  /^<?\s*file(?:\s*name)?\s*>?\s*[—–:-]?\s*<?\s*(what is (actually )?wrong|one sentence|explanation)/i;

function isTemplateEcho(text: string): boolean {
  return TEMPLATE_ECHO.test(text) || text.includes('<file>') || !text.trim();
}

export function parseReviewFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(FINDING_LINE);
    if (!match) continue;
    const severity = SEVERITY_MAP[(match[1] ?? match[2]).toLowerCase()];
    if (severity && !isTemplateEcho(match[3].trim())) {
      findings.push({ severity, text: match[3].trim() });
    }
  }
  return findings;
}

export function buildReviewPrompt(
  diff: string,
  language: AgentLanguage = 'auto',
  intent?: string,
): string {
  const clipped =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`
      : diff;

  // Kept deliberately small: extra rule blocks measurably stop the 7B from
  // doing the trace at all. See docs in the repo history for prompt trials.
  return `You are reviewing a student's code change. In the diff, lines starting with - were removed and lines starting with + were added.
${languageInstruction(language)}
${intent ? `The change was supposed to accomplish: ${intent}\n` : ''}
For EACH changed function, do this trace:
1. Write the complete NEW version of the function (the code after applying the + lines).
2. Pick one small example input.
3. Execute the new function on that input step by step, showing intermediate values.
4. State what the function SHOULD return for that input according to its name and docstring.
5. Compare. If the traced result differs from the expected result, output a line starting with [BUG] followed by the file name and one sentence explaining what the new code wrongly does.

After all traces, output your findings as lines starting with [BUG], [WARN] or [NIT].
If every trace matched, end your reply with the single word: LGTM

<diff>
${clipped}
</diff>`;
}

export interface ReviewOptions {
  diff: string;
  language?: AgentLanguage;
  /** The request the changes were meant to fulfil, for intent checking. */
  intent?: string;
  signal?: AbortSignal;
}

/** One-shot review call: fresh conversation, reviewer instructions only. */
export async function runReview(
  client: MinervaClient,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const messages: ChatMessage[] = [
    { role: 'user', content: buildReviewPrompt(options.diff, options.language, options.intent) },
  ];
  const raw = (await streamChat(client, messages, { signal: options.signal })).trim();
  const findings = parseReviewFindings(raw);
  return {
    raw,
    findings,
    hasBugs: findings.some((f) => f.severity === 'bug'),
  };
}

const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_SIZE = 16 * 1024;

/** Pending changes versus HEAD (staged, unstaged, and untracked), or null outside git. */
export async function collectGitDiff(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd: projectDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parts = stdout.trim() ? [stdout.trim()] : [];

    // `git diff HEAD` misses newly created files.
    const { stdout: untracked } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: projectDir, maxBuffer: 1024 * 1024 },
    );
    const files = untracked.split('\n').filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
    for (const file of files) {
      try {
        const content = await readFile(path.join(projectDir, file), 'utf-8');
        if (content.includes('\0') || content.length > MAX_UNTRACKED_SIZE) continue;
        parts.push(filePatch(file, '', content));
      } catch {
        // unreadable — skip
      }
    }

    return parts.length ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}
