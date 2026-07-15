import { stat } from 'node:fs/promises';
import type { MinervaClient } from '../api/client.js';
import { streamChat } from '../api/chat.js';
import type { ChatMessage } from '../types.js';
import { getTool, getTools } from '../tools/registry.js';
import { resolveInProject, type Tool } from '../tools/tool.js';
import type { AppliedChange, ChangeLog } from './context.js';
import {
  mergePartialWrite,
  protectedDefinitionNames,
  removedTopLevelDefinitions,
} from './merge.js';
import { parseToolCalls } from './parser.js';
import { needsApproval, type PermissionMode } from './permissions.js';
import { buildPreview, filePatch, readIfExists } from './preview.js';
import type { NetChange } from './rollback.js';
import { runReview } from './review.js';
import {
  detectVerifyCommand,
  requestRequiresExecution,
  runVerification,
  syntaxCheckCommand,
  undefinedNameCheckCommand,
} from './verify.js';
import { compactMessages, scrubStaleAssistantFences } from './compact.js';
import { buildRepoMap } from './repo-map.js';
import {
  buildSystemPrompt,
  buildTurnPrompt,
  formatToolResult,
  languageInstruction,
  listProjectFiles,
  loadProjectContext,
  loadProjectFileContents,
  type AgentLanguage,
} from './prompts.js';

export const MAX_TURNS = 20;
export const MAX_CALLS_PER_TURN = 3;
/** Harness-run verification commands per agent run. */
export const MAX_VERIFY_RUNS = 5;
const AGENT_ACKNOWLEDGEMENT =
  'Understood. I will act directly with the available tools, create explicitly requested new files, and verify the real result before reporting completion.';

/** Commands that count as the model verifying its own changes. */
const VERIFYISH_COMMAND =
  /\b(?:pytest|unittest|py_compile|(?:npm|pnpm|yarn|bun)\s+(?:test|run)|vitest|jest|node --test|tsc|mypy|ruff|flake8|make|cargo (?:test|check|build)|go (?:test|build)|mvn|gradle|gcc|cc|clang|g\+\+|javac)\b/;

/** Paths that look like test files (pytest/unittest/jest/vitest conventions). */
export const TEST_FILE_PATH =
  /(^|\/)(?:test_[^/]+\.[a-z0-9]+|[^/]+_test\.[a-z0-9]+|[^/]+\.(?:test|spec)\.[a-z0-9]+)$|(^|\/)tests?\//i;

const CHANGE_VERB = String.raw`(?:writ\w*|creat\w*|add\w*|updat\w*|modif\w*|fix\w*|improv\w*|generat\w*|rewrit\w*|edit\w*|chang\w*|scriv\w*|crea\w*|aggiung\w*|aggiorn\w*|modific\w*|sistem\w*|corregg\w*|genera\w*|riscriv\w*|cambi\w*)`;
// Filler words allowed between the verb and its test-object: articles and
// test-ish adjectives only, so "fix the bug … tests pass" does NOT match.
const VERB_GAP = String.raw`(?:\s+(?:the|a|an|some|more|new|unit|failing|broken|existing|missing|these|those|my|our|il|i|gli|le|la|un|una|uno|dei|delle|degli|nuovi|nuove|questi|quei|mancanti|falliti)){0,3}\s+`;
const TEST_NOUN = String.raw`(?:tests?\b|specs?\b|test\s+(?:file|case|suite)s?\b|test_\w+|\w+_test\b)`;

const WANTS_TEST_CHANGES = new RegExp(`\\b${CHANGE_VERB}${VERB_GAP}${TEST_NOUN}`, 'i');
const FORBIDS_TEST_CHANGES = new RegExp(
  `\\b(?:(?:do\\s+not|don't|dont|never|without|non|senza)\\s+${CHANGE_VERB}${VERB_GAP}${TEST_NOUN})`,
  'i',
);
const WANTS_NEW_FILES =
  /\b(?:creat\w*|writ\w*|add\w*|generat\w*|scaffold\w*|implement\w*|build\w*|crea\w*|scriv\w*|aggiung\w*|genera\w*|implementa\w*|costru\w*)\b/i;
const WANTS_MADE_ARTIFACT =
  /\bmak\w*\s+(?:(?:it|this|the|a|an)\s+){0,3}(?:new\s+)?(?:file|module|program|package|script|app|component|note)\b/i;
const FORBIDS_NEW_FILES =
  /\b(?:do\s+not|don't|dont|never|without|non|senza)\s+(?:creat\w*|writ\w*|add\w*|generat\w*|scaffold\w*|mak\w*|crea\w*|scriv\w*|aggiung\w*|genera\w*)\b/i;
const SOURCE_FILE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp)$/i;
const EXPECTS_FILE_CHANGES =
  /\b(?:fix\w*|correct\w*|creat\w*|writ\w*|add\w*|updat\w*|modif\w*|edit\w*|chang\w*|implement\w*|refactor\w*|remove\w*|rename\w*|extend\w*|expand\w*|improv\w*|corregg\w*|sistem\w*|crea\w*|scriv\w*|aggiung\w*|aggiorn\w*|modific\w*|cambi\w*|implementa\w*|rimuov\w*|rinomina\w*|estend\w*|espand\w*|amplia\w*|miglior\w*)\b/i;
/**
 * Exercise-style requests describe the PROGRAM's behavior instead of naming
 * a file change: "Chiedi all'utente tre numeri e sommali", "Ask the user for
 * a number and print the square". These expect code to be written too.
 */
const PROGRAM_SPEC =
  /\b(?:chied\w*|stamp\w*|calcol\w*|somm\w*|inser\w*|restitu\w*|print\w*|comput\w*|sum\b|input\b|output\b|ask(?:s|ing)?\b|prompt\s+the\s+user)\b/i;
const INFORMATIONAL_REQUEST =
  /^\s*(?:explain|review|inspect|analy[sz]e|describe|why|how|what|show\s+me|spiega|rivedi|analizza|descrivi|perch[eé]|come|cosa)\b/i;
const ALLOWS_DEFINITION_REMOVAL =
  /\b(?:remov\w*|delet\w*|rewrit\w*|replace\w*|refactor\w*|renam\w*|rimuov\w*|elimina\w*|riscriv\w*|sostitui\w*|rifattorizz\w*|rinomin\w*)\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Does the request explicitly ask to create or change tests? Only a change
 * verb whose direct object is a test ("write tests for utils", "fix the
 * failing test", "update test_calc.py") counts. "Fix the bug so the tests
 * pass", "verify with the tests", or naming a test file as context do not.
 */
export function requestAllowsTestEdit(prompt: string, testPath: string): boolean {
  if (FORBIDS_TEST_CHANGES.test(prompt)) return false;
  if (WANTS_TEST_CHANGES.test(prompt)) return true;
  const base = testPath.split('/').at(-1);
  if (!base) return false;
  const targetsFile = new RegExp(`\\b${CHANGE_VERB}${VERB_GAP}\`?${escapeRegExp(base)}`, 'i');
  return targetsFile.test(prompt);
}

/** A fix request may edit existing files, but must not invent unrelated ones. */
export function requestAllowsNewFile(prompt: string): boolean {
  return !FORBIDS_NEW_FILES.test(prompt) &&
    (WANTS_NEW_FILES.test(prompt) || WANTS_MADE_ARTIFACT.test(prompt));
}

export function requestExpectsChanges(prompt: string): boolean {
  return (
    !INFORMATIONAL_REQUEST.test(prompt) &&
    (EXPECTS_FILE_CHANGES.test(prompt) || PROGRAM_SPEC.test(prompt))
  );
}

const EXPLICIT_SOURCE_PATH =
  /(?:^|[\s`"'([{])((?:\.\/)?(?:[\w@+.-]+\/)*[\w@+.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp))(?=$|[\s`"',;:!?)\]}]|\.(?:\s|$))/gi;

/** Names that appear with call parens in prose without being the target. */
const COMMON_CALL_NAMES = new Set([
  'print', 'input', 'println', 'printf', 'scanf', 'main', 'len', 'range',
  'str', 'int', 'float', 'bool', 'log', 'console', 'require', 'import',
]);

/**
 * Function names the request spells out with call syntax, e.g. "add a
 * function is_even(n)". A run that never defines them did not do the task,
 * no matter how cleanly its other changes verify.
 */
export function requestRequiredDefinitions(prompt: string): string[] {
  const names = [...prompt.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)]
    .map((match) => match[1])
    .filter((name) => !COMMON_CALL_NAMES.has(name.toLowerCase()));
  return [...new Set(names)];
}

/** Does this file content define (not merely call) the named function? */
export function definesIdentifier(content: string, name: string): boolean {
  return new RegExp(
    String.raw`\b(?:def|function|func|fn)\s+${name}\s*\(` +
      String.raw`|(?:const|let|var)\s+${name}\s*=` +
      String.raw`|class\s+${name}\b` +
      String.raw`|\b(?:int|void|double|float|char|bool|long|unsigned)\s+\**${name}\s*\(`,
  ).test(content);
}

/** Source paths the student wrote literally in the request, in request order. */
export function requestExplicitSourcePaths(prompt: string): string[] {
  const paths = [...prompt.matchAll(EXPLICIT_SOURCE_PATH)].map((match) =>
    match[1].replace(/^\.\//, ''),
  );
  return [...new Set(paths)];
}

export interface ToolCallEvent {
  tool: Tool;
  input: Record<string, unknown>;
  summary: string;
}

export interface AgentEvents {
  /** Visible assistant text for a turn, tool blocks already stripped. */
  onText(text: string): void;
  /** Harness-side progress notes (verification, review). */
  onStatus?(text: string): void;
  onToolStart(event: ToolCallEvent): void;
  onToolEnd(event: ToolCallEvent & { ok: boolean; result: string }): void;
  /** Ask the user to approve a tool call. Resolves false to deny. */
  confirm(event: ToolCallEvent & { preview: string }): Promise<boolean>;
}

export interface AgentOptions {
  history: ChatMessage[];
  prompt: string;
  /**
   * The last change-expecting request that produced no change. When the new
   * prompt is a bare affirmation ("yes", "good. write"), this is the task.
   */
  pendingIntent?: string | null;
  projectDir: string;
  permissionMode: PermissionMode;
  /** Reply language. Auto follows the language of the latest user message. */
  language?: AgentLanguage;
  /** Self-review applied changes before finishing. Defaults on in auto mode. */
  review?: boolean;
  events: AgentEvents;
  signal?: AbortSignal;
  changeLog?: ChangeLog;
}

export type AgentStatus =
  | 'completed'
  | 'aborted'
  | 'turn-limit'
  | 'no-change'
  | 'requirements-unmet'
  | 'model-error';

export interface AgentResult {
  /** Updated conversation history (without the system prompt). */
  history: ChatMessage[];
  finalText: string;
  /** File changes applied during this run. */
  changes: AppliedChange[];
  status: AgentStatus;
  /** Outcome of the last verification run; null when none was needed. */
  verified: boolean | null;
  /** Last harness-run verification, as evidence for the end-of-run report. */
  verification: VerificationEvidence | null;
  /** Net first-to-final contents per changed file, for diffs and rollback. */
  netChanges: NetChange[];
  /**
   * The effective request when it expected changes but none were applied —
   * pass back in on the next call so "yes" resumes this task.
   */
  pendingIntent: string | null;
}

export interface VerificationEvidence {
  command: string;
  output: string;
  source: string;
  ok: boolean;
}

interface FileChange extends AppliedChange {
  before: string;
  after: string;
  /** Whether the file existed before this call — '' content is ambiguous. */
  existedBefore: boolean;
}

async function executeCall(
  tool: Tool,
  input: Record<string, unknown>,
  opts: AgentOptions,
): Promise<{ ok: boolean; result: string; change?: FileChange }> {
  try {
    const isFileChange =
      (tool.name === 'Write' || tool.name === 'Edit') && typeof input.path === 'string';
    const file = isFileChange ? resolveInProject(opts.projectDir, String(input.path)) : null;
    const before = file ? await readIfExists(file) : '';
    const existedBefore = file
      ? await stat(file).then(
          () => true,
          () => false,
        )
      : false;

    const result = await tool.call(input, { projectDir: opts.projectDir, signal: opts.signal });
    if (file) {
      const after = await readIfExists(file);
      // Creating a file is a net change even when it is empty (before ==
      // after == '') — it must be tracked so rollback can remove it.
      if (after !== before || !existedBefore) {
        const change: FileChange = {
          path: String(input.path),
          patch: filePatch(String(input.path), before, after),
          before,
          after,
          existedBefore,
        };
        return { ok: true, result, change };
      }
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, result: err instanceof Error ? err.message : String(err) };
  }
}

/** Volatile bits (paths, addresses, timings) stripped so identical verification failures compare equal. */
function normalizeVerifyOutput(output: string, projectDir: string): string {
  return output
    .replaceAll(projectDir, '')
    .replace(/0x[0-9a-fA-F]+/g, '0x…')
    .replace(/\b\d+(?:\.\d+)?\s*s(?:econds?)?\b/g, '·s')
    .split('\n')
    // Tracebacks echo the failing source line (deeply indented); cosmetic
    // rewrites of that line must not make the same error look new.
    .filter((line) => !/^\s{3,}/.test(line))
    .join('\n')
    .trim();
}

/** First line of a multi-line command, for status/tool display. */
function compactCommand(command: string): string {
  const [first, ...rest] = command.split('\n');
  return rest.length ? `${first} …` : command;
}

function turnLimitMessage(language: AgentLanguage = 'auto'): string {
  return language === 'it'
    ? '(Limite di turni raggiunto — riprendi con un nuovo messaggio.)'
    : '(Turn limit reached — continue with a new message.)';
}

/** The model claims to have acted ("I've fixed…") without any tool call. */
const ACTION_CLAIM =
  /\b(?:i(?:'ve| have)?\s+(?:fixed|updated|changed|corrected|modified|implemented|created|added|written)|ho\s+(?:corretto|aggiornato|modificato|sistemato|implementato|creato|scritto|aggiunto|generato))\b/i;

/** The model hallucinates a web UI ("click the Show Code button"). */
const UI_CLAIM = /\b(?:show\s+code|pulsante|button|click\w*|clicc\w*)\b/i;

/** The model refuses, wrongly claiming it cannot write files or run code. */
const CAPABILITY_REFUSAL =
  /\b(?:(?:i\s+am|i'm)\s+(?:unable|not able)\s+to|i\s+can(?:no|')t|non\s+(?:posso|sono in grado di))\s+(?:perform|write|creat\w*|run|execut\w*|modif\w*|access|scriv\w*|cre\w*|esegu\w*)/i;

/** Code structure in plain text — the model forgot the fences entirely. */
const UNFENCED_CODE =
  /^[ \t]*(?:def\s+\w+\s*\(|class\s+\w+\s*[:({]|from\s+[\w.]+\s+import\s|#include\s*[<"]|function\s+\w+\s*\(|(?:int|void)\s+main\s*\()/m;

/** The model stalls with a question/offer instead of acting. */
const QUESTION_OFFER =
  /\b(?:would you like|do you want|shall i|should i|vuoi(?: che)?|desideri|preferisci|posso procedere|procedo)\b/i;

/** A reply that only converses: no fence, no code, ends by asking. */
function isQuestionOnlyReply(response: string): boolean {
  if (response.includes('```') || UNFENCED_CODE.test(response)) return false;
  const lastLine = response
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return !!lastLine && (lastLine.endsWith('?') || QUESTION_OFFER.test(response));
}

/** The request asks for a program that READS USER INPUT. */
const EXPECTS_USER_INPUT =
  /\b(?:chied\w*|inserisc\w*|inserire|ask(?:s|ing)?\b|prompt(?:s|ing)?\s+(?:the\s+)?user)\b/i;

/** Does any changed Python file actually read from stdin? */
function readsUserInput(contents: string[]): boolean {
  return contents.some((c) => /\binput\s*\(|\bsys\.stdin\b|\braw_input\s*\(/.test(c));
}

/**
 * "yes" / "good. write" / "va bene, procedi" — a go-ahead carrying no task
 * of its own. Every deterministic gate keyed on the prompt would otherwise
 * evaluate the affirmation as the task and disarm itself.
 */
const AFFIRMATION_WORDS = new Set([
  'yes', 'yep', 'yeah', 'ok', 'okay', 'sure', 'good', 'great', 'perfect', 'fine',
  'go', 'ahead', 'do', 'it', 'now', 'please', 'proceed', 'continue', 'write', 'apply',
  'si', 'sì', 'va', 'bene', 'procedi', 'continua', 'scrivi', 'scrivilo', 'fallo',
  'applica', 'ora', 'dai', 'certo', 'perfetto',
]);

export function isBareAffirmation(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[.,!;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 && words.length <= 5 && words.every((word) => AFFIRMATION_WORDS.has(word))
  );
}

/** One-time correction when the model showed code but nothing was applicable. */
function formatNudge(projectFiles: string[], requiredPaths: string[] = []): string {
  const example = requiredPaths[0] ?? projectFiles.find((f) => !f.endsWith('/')) ?? 'main.py';
  return `I could not apply anything from that reply. This is a plain terminal: there are no buttons, panels, or "Show Code" links, so any code must be written out in the reply itself. To change a file, either emit a structured tool call:

<minerva_tool name="Write">
<path>${example}</path>
<content>
...the COMPLETE new file contents...
</content>
</minerva_tool>

or put the filename on its own line immediately before a fenced code block containing the COMPLETE file contents:

Updated \`${example}\`:
\`\`\`
...
\`\`\`

Only use file paths that exist in the project listing (or clearly new files). Reply with the corrected change now.`;
}

export async function runAgent(client: MinervaClient, opts: AgentOptions): Promise<AgentResult> {
  const tools = getTools();
  const auto = opts.permissionMode === 'dontAsk';
  // "yes" carries no task: every gate below keys on the prompt, so a bare
  // go-ahead resumes the stored unfulfilled request instead.
  const prompt =
    opts.pendingIntent && isBareAffirmation(opts.prompt) ? opts.pendingIntent : opts.prompt;
  const selfReview = opts.review ?? auto;
  opts.events.onStatus?.('Mapping repository context…');
  const [projectContext, repoMap] = await Promise.all([
    loadProjectContext(opts.projectDir),
    buildRepoMap({ projectDir: opts.projectDir, query: prompt }),
  ]);
  const projectFiles = repoMap.files;
  const knownProjectFiles = new Set(projectFiles.map((file) => file.replace(/^\.\//, '')));
  // A path mentioned as context is not automatically an instruction to
  // create it (for example, "fix calc.py; the error mentions missing.py").
  // Only enforce absent paths when the request actually authorizes creating
  // a file.
  const requiredNewPaths = requestAllowsNewFile(prompt)
    ? requestExplicitSourcePaths(prompt).filter((file) => !knownProjectFiles.has(file))
    : [];
  const projectHasSourceFiles = projectFiles.some((file) => SOURCE_FILE_PATH.test(file));
  const { files: fileContents, skipped } = await loadProjectFileContents(
    opts.projectDir,
    repoMap.contextFiles,
  );
  const instructions = buildSystemPrompt({
    projectDir: opts.projectDir,
    tools,
    language: opts.language,
    autonomous: auto,
    projectContext,
  });

  // Chat Minerva's Open WebUI drops system-role messages, so the agent
  // instructions ride in a stable first user message. Refreshable repository
  // context stays in a separate turn so old file snapshots can be compacted.
  const firstTurn = opts.history.length === 0;
  let initialVerification: { command: string; output: string } | undefined;
  if (auto && firstTurn && requestExpectsChanges(prompt)) {
    const cmd = await detectVerifyCommand(opts.projectDir, projectFiles, []);
    if (cmd && /test|pytest|unittest|\.minervacli\.md/i.test(cmd.source)) {
      const bash = getTool('Bash');
      const event: ToolCallEvent | null = bash
        ? { tool: bash, input: { command: cmd.command }, summary: compactCommand(cmd.command) }
        : null;
      opts.events.onStatus?.(
        `Running initial verification (${cmd.source}): ${compactCommand(cmd.command)}`,
      );
      if (event) opts.events.onToolStart(event);
      const baseline = await runVerification(cmd, opts.projectDir, opts.signal);
      if (event) opts.events.onToolEnd({ ...event, ok: baseline.ok, result: baseline.output });
      if (!baseline.ok) initialVerification = { command: cmd.command, output: baseline.output };
    }
  }
  const requestedCProgram =
    requestRequiresExecution(prompt) &&
    requiredNewPaths.some((file) => /\.(?:c|cc|cpp|cxx)$/i.test(file));
  const acceptanceRequirements = requiredNewPaths.length
    ? `\n\nHard acceptance requirement: create the exact requested path${requiredNewPaths.length === 1 ? '' : 's'} ${requiredNewPaths.join(', ')}. Do not substitute another filename.${requestRequiresExecution(prompt) ? ' This is a small standalone program: keep each file under 80 lines, use direct standard-language control flow, and emit the complete file action now before any explanation.' : ''}${requestedCProgram ? ' C/C++ hygiene: use a conventional main entry point, include every standard header you use, keep identifier casing consistent, and prefer small bounded loops and helpers over recursion, variable-length arrays, or pointer tricks.' : ''}`
    : '';
  const userContent = `${languageInstruction(opts.language)}\n\n${buildTurnPrompt({
    request: prompt,
    repositoryMap: repoMap.map,
    fileContents,
    skippedFiles: skipped,
    initialVerification,
  })}${acceptanceRequirements}`;

  // Old assistant code proposals in history are the model's main
  // regurgitation seed (observed live: a prime printer re-emitted for a
  // sorting exercise). Stub them; the files on disk are authoritative.
  let messages: ChatMessage[] = [
    ...scrubStaleAssistantFences(opts.history),
    ...(firstTurn
      ? [
          { role: 'user' as const, content: instructions },
          { role: 'assistant' as const, content: AGENT_ACKNOWLEDGEMENT },
        ]
      : []),
    { role: 'user', content: userContent },
  ];
  let finalText = '';
  let status: AgentStatus = 'completed';
  const changes: AppliedChange[] = [];
  /** First-seen and latest contents per changed file, for the net diff. */
  const netState = new Map<string, { before: string; after: string; existedBefore: boolean }>();
  /** Files changed since the last verification (harness- or model-run). */
  let unverified: string[] = [];
  // Object property so the closure assignment survives TS narrowing.
  const verifyState = {
    last: null as boolean | null,
    evidence: null as VerificationEvidence | null,
  };
  let verifyRuns = 0;
  let changeSerial = 0;
  let lastVerifySerial = -1;
  let failedVerificationNudgeSerial = -1;
  let failedVerificationNudges = 0;
  let nudged = false;
  let questionNudged = false;
  let truncationNudges = 0;
  let consecutiveNoopWrites = 0;
  const verifyFailSignatures: string[] = [];
  let stuckOnIdenticalError = false;
  let requirementsNudges = 0;
  let missingDefNudges = 0;
  let inputNudges = 0;
  const requiredDefs = requestExpectsChanges(prompt)
    ? requestRequiredDefinitions(prompt)
    : [];
  const requiresUserInput =
    requestExpectsChanges(prompt) && EXPECTS_USER_INPUT.test(prompt);
  let reviewed = false;
  let compactionReported = false;

  const compactContext = () => {
    const result = compactMessages(messages);
    messages = result.messages;
    if (result.compacted && !compactionReported) {
      compactionReported = true;
      opts.events.onStatus?.(
        `Compacted context from ~${result.before.estimatedTokens.toLocaleString('en-US')} to ~${result.after.estimatedTokens.toLocaleString('en-US')} input tokens.`,
      );
    }
  };

  const focusFailedRepair = async (command: string, output: string) => {
    const currentFiles = await Promise.all(
      [...new Set(unverified)].slice(0, 3).map(async (file) => {
        try {
          const content = await readIfExists(resolveInProject(opts.projectDir, file));
          return `=== ${file} ===\n${content.slice(0, 24 * 1024)}`;
        } catch {
          return `=== ${file} ===\n(unavailable)`;
        }
      }),
    );
    messages = [
      { role: 'user', content: instructions },
      { role: 'assistant', content: AGENT_ACKNOWLEDGEMENT },
      {
        role: 'user',
        content: `${languageInstruction(opts.language)}\n\nFocused autonomous repair.\nOriginal student request: ${prompt}\n${requiredNewPaths.length ? `Required output path: ${requiredNewPaths.join(', ')}\n` : ''}The current source below failed a REAL verification command. Fix the actual error or timeout with the simplest complete implementation. Emit the Write/Edit action first, with no tutorial and no partial snippets.\n\n${currentFiles.join('\n\n')}\n\nVerification failure:\n$ ${command}\n${output}`,
      },
    ];
  };

  const recordChange = (change: FileChange) => {
    changeSerial++;
    consecutiveNoopWrites = 0;
    changes.push({ path: change.path, patch: change.patch });
    opts.changeLog?.add({ path: change.path, patch: change.patch });
    unverified.push(change.path);
    const net = netState.get(change.path);
    if (net) {
      net.after = change.after;
    } else {
      netState.set(change.path, {
        before: change.before,
        after: change.after,
        existedBefore: change.existedBefore,
      });
    }
  };

  /**
   * Runs the detected verification command and appends a result message the
   * model can act on. Returns false when there is nothing to verify.
   */
  const harnessVerify = async (results: string[]): Promise<boolean> => {
    if (!auto || !unverified.length || verifyRuns >= MAX_VERIFY_RUNS) return false;
    // A failed check is only useful again after the source changed. Re-running
    // the identical command against identical files burns the retry budget and
    // gives the model no new information.
    if (verifyState.last === false && lastVerifySerial === changeSerial) return false;
    // Re-list: the run may have created test files that change the choice.
    const files = await listProjectFiles(opts.projectDir);
    const cmd = await detectVerifyCommand(
      opts.projectDir,
      files,
      unverified,
      undefined,
      prompt,
    );
    if (!cmd) {
      // No verifier applies to these paths (e.g. docs) — they can never be
      // checked, so they must not keep the run marked unverified forever.
      unverified = [];
      return false;
    }

    verifyRuns++;
    const bash = getTool('Bash');
    const event: ToolCallEvent | null = bash
      ? { tool: bash, input: { command: cmd.command }, summary: compactCommand(cmd.command) }
      : null;
    opts.events.onStatus?.(`Verifying changes (${cmd.source}): ${compactCommand(cmd.command)}`);
    if (event) opts.events.onToolStart(event);
    const { ok, output } = await runVerification(cmd, opts.projectDir, opts.signal);
    if (event) opts.events.onToolEnd({ ...event, ok, result: output });

    verifyState.last = ok;
    verifyState.evidence = { command: cmd.command, output, source: cmd.source, ok };
    lastVerifySerial = changeSerial;
    // Only a passing check clears the dirty set — a failed one stays due
    // so the stop-branch retries after the model's next fix attempt.
    if (ok) {
      unverified = [];
      verifyFailSignatures.length = 0;
    } else {
      // Same command, same normalized error, three runs in a row — each
      // "fix" changed bytes but not behavior. Further retries are
      // information-free; stop honestly instead of burning the budget.
      const signature = `${cmd.command}\n${normalizeVerifyOutput(output, opts.projectDir)}`;
      verifyFailSignatures.push(signature);
      if (
        verifyFailSignatures.length >= 3 &&
        verifyFailSignatures.slice(-3).every((s) => s === signature)
      ) {
        stuckOnIdenticalError = true;
        return true;
      }
      await focusFailedRepair(cmd.command, output);
    }
    const guidance = ok
      ? 'Verification passed. If the request is complete, briefly summarize what you changed — do not repeat file contents.'
      : `This verification command failed. Use the REAL error output above and apply a source fix now — do not merely explain it, do not weaken tests, and do not send partial snippets.${requiredNewPaths.length ? ` Replace the required ${requiredNewPaths.join(', ')} with a complete minimal implementation when a whole-file rewrite is needed.` : ''} The check will run again only after a file changes.`;
    results.push(
      `${formatToolResult('Bash', `$ ${cmd.command}\n${output}`, ok)}\n\n${guidance}`,
    );
    return true;
  };

  let modelRetries = 1;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    compactContext();
    let response: string;
    try {
      response = await streamChat(client, messages, { signal: opts.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // One transient timeout must not kill a whole run — the request is
      // idempotent (nothing was appended to the conversation yet).
      if (modelRetries > 0 && !opts.signal?.aborted) {
        modelRetries--;
        opts.events.onStatus?.(`⚠ Model request failed: ${message} — retrying once…`);
        continue;
      }
      status = 'model-error';
      finalText = message;
      opts.events.onStatus?.(`⚠ Model request failed: ${message}`);
      break;
    }
    messages.push({ role: 'assistant', content: response });

    // The code-block fallback is the primary write path for ChatMinerva —
    // the model proposes whole files in fences rather than emitting tool
    // blocks. Permission mode still gates whether the Write auto-applies.
    const { toolCalls, text, suspectTruncated } = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: projectFiles,
      preferredFiles: requestExpectsChanges(prompt)
        ? requiredNewPaths.length
          ? requiredNewPaths
          : repoMap.contextFiles.filter((file) => !TEST_FILE_PATH.test(file))
        : undefined,
      // In assisted mode the student approves every proposed Write, so a
      // best-guess target for a filename-less fence beats a dead end.
      guessPreferredFile: !auto,
      // "Write me a script …" against an empty project: default to main.py
      // (& co.) so the first reply's code is applied instead of dropped.
      fallbackNewFile: requestExpectsChanges(prompt),
      knownTools: tools.map((t) => t.name),
    });
    if (text) {
      finalText = text;
      opts.events.onText(text);
    }

    if (opts.signal?.aborted) {
      status = 'aborted';
      break;
    }

    if (!toolCalls.length) {
      // The model showed code fences (or claims it changed something)
      // but nothing was applied — restate the format once, don't give up.
      if (
        !nudged &&
        !changes.length &&
        (response.includes('```') ||
          ACTION_CLAIM.test(response) ||
          UI_CLAIM.test(response) ||
          // Refusals and fence-less code only warrant a retry when the
          // request actually asked for a change.
          (requestExpectsChanges(prompt) &&
            (CAPABILITY_REFUSAL.test(response) || UNFENCED_CODE.test(response))))
      ) {
        nudged = true;
        messages.push({
          role: 'user',
          content: formatNudge(projectFiles, requiredNewPaths),
        });
        continue;
      }

      // The model stalls with a question ("Would you like me to add
      // that?") on a request that plainly asked for a change. Answer it
      // deterministically once — the observed alternative is a dead loop
      // of offers the student keeps approving to no effect.
      if (
        !questionNudged &&
        !changes.length &&
        requestExpectsChanges(prompt) &&
        isQuestionOnlyReply(response)
      ) {
        questionNudged = true;
        messages.push({
          role: 'user',
          content: `Yes. Do not ask further questions — proceed with your best interpretation now. Emit the complete file: the filename on its own line, then one fenced code block with the COMPLETE contents.\nOriginal request: ${prompt}`,
        });
        continue;
      }

      const missingRequiredPaths = requiredNewPaths.filter((file) => !netState.has(file));
      if (auto && missingRequiredPaths.length) {
        if (requirementsNudges < 3) {
          requirementsNudges++;
          messages = [
            { role: 'user', content: instructions },
            { role: 'assistant', content: AGENT_ACKNOWLEDGEMENT },
            {
              role: 'user',
              content: `${languageInstruction(opts.language)}\n\nAutonomous action required. The student explicitly asked you to CREATE ${missingRequiredPaths.join(', ')}, so creating ${missingRequiredPaths.length === 1 ? 'this new file is' : 'these new files is'} allowed. Emit the complete Write action now; do not refuse, explain, ask questions, mention unrelated files, or substitute another path.\nOriginal request: ${prompt}${requestedCProgram ? '\nKeep the standalone C/C++ program under 80 lines with conventional headers, consistent lowercase loop identifiers, simple terminating loops, and no pointer tricks.' : ''}`,
            },
          ];
          continue;
        }
        status = 'requirements-unmet';
        opts.events.onStatus?.(
          `⚠ Required output ${missingRequiredPaths.join(', ')} was not created.`,
        );
        break;
      }

      // The request spelled out function names (e.g. "add is_even(n)") that
      // no changed file defines — passing checks on OTHER lines is not the
      // task. Ask for the missing definition, then fail honestly.
      const missingDefs =
        auto && requiredDefs.length
          ? requiredDefs.filter(
              (name) =>
                ![...netState.values()].some(
                  (s) => definesIdentifier(s.after, name) || definesIdentifier(s.before, name),
                ),
            )
          : [];
      if (missingDefs.length) {
        if (missingDefNudges < 2) {
          missingDefNudges++;
          messages.push({
            role: 'user',
            content: `The request explicitly requires defining ${missingDefs.map((n) => `${n}(...)`).join(', ')} and the current changes do not define ${missingDefs.length === 1 ? 'it' : 'them'}. Emit a Write or Edit now that adds the missing definition${missingDefs.length === 1 ? '' : 's'} without removing existing code.`,
          });
          continue;
        }
        status = 'requirements-unmet';
        opts.events.onStatus?.(
          `⚠ Required function${missingDefs.length === 1 ? '' : 's'} ${missingDefs.join(', ')} ${missingDefs.length === 1 ? 'was' : 'were'} never defined.`,
        );
        break;
      }

      // "Chiedi all'utente…" / "Ask the user…" programs must actually read
      // input. A run that changed Python files none of which touch stdin
      // did something else entirely (usually regurgitated context code).
      if (auto && requiresUserInput && netState.size) {
        const pyContents = [...netState.entries()]
          .filter(([path]) => path.endsWith('.py'))
          .map(([, s]) => s.after);
        if (pyContents.length && !readsUserInput(pyContents)) {
          if (inputNudges < 2) {
            inputNudges++;
            messages.push({
              role: 'user',
              content:
                'The request asks for a program that READS USER INPUT, but no changed file calls input(). Rewrite the requested program so it asks the user with input() and prints the result.',
            });
            continue;
          }
          status = 'requirements-unmet';
          opts.events.onStatus?.('⚠ The requested program never reads user input.');
          break;
        }
      }

      if (
        auto &&
        unverified.length &&
        verifyState.last === false &&
        lastVerifySerial === changeSerial
      ) {
        if (failedVerificationNudgeSerial !== changeSerial) {
          failedVerificationNudgeSerial = changeSerial;
          failedVerificationNudges = 0;
        }
        if (failedVerificationNudges < 3) {
          failedVerificationNudges++;
          messages.push({
            role: 'user',
            content: 'The previous verification failed and this reply did not apply a source fix. Do not merely explain or repeat code snippets: update the failing file now with a Write or Edit tool call (or one complete filename-labelled file block). Verification will run again only after the file changes.',
          });
          continue;
        }
        break;
      }

      // Changes still unverified when the model stopped — verify them now.
      const pending: string[] = [];
      if (await harnessVerify(pending)) {
        if (stuckOnIdenticalError) {
          status = 'requirements-unmet';
          opts.events.onStatus?.(
            '⚠ Verification failed with the identical error 3 times — stopping. The last error output is shown above.',
          );
          break;
        }
        messages.push({ role: 'user', content: pending.join('\n\n') });
        continue;
      }

      // A verifier applies but the current source still has not passed. Do
      // not self-review or claim completion for a known-broken state.
      if (unverified.length) break;

      // Everything applied and verified — run one self-review pass. The
      // review is strictly ADVISORY: a 7B reviewer hallucinates bugs often
      // enough that letting it trigger a fix cycle destroys verified work
      // (observed live: a correct, passing script rewritten into garbage).
      // Deterministic verification stays the only gate; findings are shown
      // so the student can judge them.
      if (selfReview && auto && netState.size && !reviewed) {
        reviewed = true;
        opts.events.onStatus?.('Reviewing applied changes…');
        const diff = [...netState.entries()]
          .filter(([, s]) => s.before !== s.after)
          .map(([path, s]) => filePatch(path, s.before, s.after))
          .join('\n\n');
        try {
          const review = await runReview(client, {
            diff,
            language: opts.language,
            intent: prompt,
            signal: opts.signal,
          });
          opts.events.onText(`Code review (advisory):\n${review.raw}`);
          if (review.hasBugs) {
            opts.events.onStatus?.(
              '⚠ The advisory review flagged possible issues. Double-check them yourself — the reviewer is a 7B model and is often wrong, so verified files were not changed automatically.',
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          opts.events.onStatus?.(
            `⚠ Advisory review unavailable: ${message}. Deterministically verified files were left unchanged.`,
          );
        }
      }
      break;
    }

    const results: string[] = [];
    const assistedCodeblockOnly =
      !auto && toolCalls.every((c) => c.source === 'codeblock');

    // The auto-closed final fence may hold half a file: its Write is the
    // one produced from that fence (the last code-block Write).
    const truncatedCall = suspectTruncated
      ? [...toolCalls].reverse().find((c) => c.source === 'codeblock' && c.tool === 'Write')
      : undefined;

    for (const call of toolCalls.slice(0, MAX_CALLS_PER_TURN)) {
      if (opts.signal?.aborted) break;

      const tool = getTool(call.tool);
      if (!tool) {
        results.push(formatToolResult(call.tool, `Unknown tool: ${call.tool}`, false));
        continue;
      }

      const parsed = tool.inputSchema.safeParse(call.args);
      if (!parsed.success) {
        results.push(
          formatToolResult(tool.name, `Invalid arguments: ${parsed.error.message}`, false),
        );
        continue;
      }

      const input = parsed.data as Record<string, unknown>;

      if (call === truncatedCall) {
        if (auto && truncationNudges < 1) {
          truncationNudges++;
          const refused = `Refused: your reply was cut off mid-file, so this Write to ${input.path} is likely incomplete. Resend the COMPLETE ${input.path} in one fenced code block, nothing after it.`;
          opts.events.onToolEnd({
            tool,
            input,
            summary: tool.summarize(input),
            ok: false,
            result: refused,
          });
          results.push(formatToolResult(tool.name, refused, false));
          continue;
        }
        if (!auto) {
          opts.events.onStatus?.(
            `⚠ The reply looks cut off — the proposed ${input.path} may be incomplete.`,
          );
        }
      }

      let normalizedInputPath =
        typeof input.path === 'string' ? input.path.replace(/^\.\//, '') : null;
      const requiredCaseMatch = normalizedInputPath
        ? requiredNewPaths.find(
            (required) => required.toLowerCase() === normalizedInputPath?.toLowerCase(),
          )
        : undefined;
      if (
        auto &&
        requiredCaseMatch &&
        normalizedInputPath !== requiredCaseMatch &&
        (tool.name === 'Write' || tool.name === 'Edit')
      ) {
        input.path = requiredCaseMatch;
        normalizedInputPath = requiredCaseMatch;
      }
      if (
        auto &&
        (tool.name === 'Write' || tool.name === 'Edit') &&
        normalizedInputPath &&
        SOURCE_FILE_PATH.test(normalizedInputPath) &&
        !knownProjectFiles.has(normalizedInputPath) &&
        requiredNewPaths.length &&
        !requiredNewPaths.includes(normalizedInputPath)
      ) {
        const refused = `Refused: the request explicitly requires ${requiredNewPaths.join(', ')}, not ${input.path}. Create the exact requested path and do not invent an alternative source filename.`;
        opts.events.onToolEnd({
          tool,
          input,
          summary: tool.summarize(input),
          ok: false,
          result: refused,
        });
        results.push(formatToolResult(tool.name, refused, false));
        continue;
      }

      if (
        auto &&
        tool.name === 'Write' &&
        normalizedInputPath &&
        requiredNewPaths.includes(normalizedInputPath) &&
        requestRequiresExecution(prompt) &&
        /\.(?:c|cc|cpp|cxx)$/i.test(normalizedInputPath) &&
        typeof input.content === 'string' &&
        !/\b(?:int|void)\s+main\s*\([^)]*\)\s*\{/s.test(input.content)
      ) {
        const refused = `Refused: ${input.path} is the requested executable program, but this Write is only a partial snippet and has no complete main function. Send the COMPLETE ${input.path} file in one Write (or use Edit for a focused replacement).`;
        opts.events.onToolEnd({
          tool,
          input,
          summary: tool.summarize(input),
          ok: false,
          result: refused,
        });
        results.push(formatToolResult(tool.name, refused, false));
        continue;
      }

      if (
        auto &&
        (tool.name === 'Write' || tool.name === 'Edit') &&
        typeof input.path === 'string' &&
        !knownProjectFiles.has(input.path.replace(/^\.\//, '')) &&
        projectHasSourceFiles &&
        !requestAllowsNewFile(prompt)
      ) {
        const refused = `Refused: ${input.path} does not exist and this request did not ask to create files. Fix the relevant existing source files; do not invent unrelated files.`;
        opts.events.onToolEnd({
          tool,
          input,
          summary: tool.summarize(input),
          ok: false,
          result: refused,
        });
        results.push(formatToolResult(tool.name, refused, false));
        continue;
      }

      // In auto mode nothing stops a weak model from "fixing" a failure by
      // rewriting the tests — refuse test-file writes the student did not
      // ask for. Assisted mode keeps the human approval as the gate.
      if (
        auto &&
        (tool.name === 'Write' || tool.name === 'Edit') &&
        typeof input.path === 'string' &&
        TEST_FILE_PATH.test(input.path) &&
        !requestAllowsTestEdit(prompt, input.path)
      ) {
        const refused = `Refused: ${input.path} is a test file and the request did not ask to change tests. The existing tests define the expected behavior — fix the SOURCE files so they pass.`;
        opts.events.onToolEnd({
          tool,
          input,
          summary: tool.summarize(input),
          ok: false,
          result: refused,
        });
        results.push(formatToolResult(tool.name, refused, false));
        continue;
      }

      // Preserve-bias (partial-write merging, refusing definition removal)
      // protects the STUDENT's pre-existing work. A file this run created
      // has none — merging or refusing there only traps the model with its
      // own broken first draft instead of letting it rewrite cleanly.
      const netEntry =
        typeof input.path === 'string'
          ? netState.get(input.path) ?? netState.get(input.path.replace(/^\.\//, ''))
          : undefined;
      const createdThisRun = netEntry?.existedBefore === false;

      // A code-block "file" that only re-states some existing functions is
      // a partial update — merge it instead of wiping the rest of the file.
      if (call.source === 'codeblock' && tool.name === 'Write' && !createdThisRun) {
        try {
          const target = resolveInProject(opts.projectDir, String(input.path));
          const existing = await readIfExists(target);
          // A request that names its new functions ("add is_even(n)") does
          // not authorize rewriting unmentioned existing ones — the model
          // often restates them with subtly broken bodies.
          const protectedNames = requiredDefs.length
            ? protectedDefinitionNames(String(input.path), existing, prompt)
            : undefined;
          const merged = mergePartialWrite(
            String(input.path),
            existing,
            String(input.content),
            protectedNames,
          );
          if (merged !== null) input.content = merged;
        } catch {
          // escaping path — the Write itself will fail with the real error
        }
      }

      if (
        auto &&
        tool.name === 'Write' &&
        typeof input.path === 'string' &&
        typeof input.content === 'string' &&
        !createdThisRun &&
        !ALLOWS_DEFINITION_REMOVAL.test(prompt)
      ) {
        try {
          const target = resolveInProject(opts.projectDir, input.path);
          const removed = removedTopLevelDefinitions(
            input.path,
            await readIfExists(target),
            input.content,
          );
          if (removed.length) {
            const refused = `Refused: this overwrite would delete unrelated definitions (${removed.join(', ')}). Make a focused replacement and preserve existing functions/classes.`;
            opts.events.onToolEnd({
              tool,
              input,
              summary: tool.summarize(input),
              ok: false,
              result: refused,
            });
            results.push(formatToolResult(tool.name, refused, false));
            continue;
          }
        } catch {
          // The Write call reports path/read failures with its normal error.
        }
      }

      const event: ToolCallEvent = { tool, input, summary: tool.summarize(input) };

      if (needsApproval(tool, opts.permissionMode)) {
        let preview: string;
        try {
          preview = await buildPreview(tool.name, input, opts.projectDir);
        } catch (err) {
          preview = `(preview unavailable: ${err instanceof Error ? err.message : String(err)})`;
        }
        const approved = await opts.events.confirm({ ...event, preview });
        if (!approved) {
          const denied = 'User denied this tool call. Do not retry it; ask what to do instead.';
          opts.events.onToolEnd({ ...event, ok: false, result: 'denied' });
          results.push(formatToolResult(tool.name, denied, false));
          continue;
        }
      }

      opts.events.onToolStart(event);
      const { ok, result, change } = await executeCall(tool, input, opts);

      // A Write that re-sends the file's current bytes is the model spinning
      // in place. Say so explicitly — the plain success text reads as
      // progress and the observed result is an endless resend loop.
      const noopWrite =
        ok && !change && (tool.name === 'Write' || tool.name === 'Edit');
      const reported = noopWrite
        ? `No change: ${input.path} already contains exactly this content.${verifyState.last === false ? ' The last verification failure is therefore still unresolved — send a DIFFERENT implementation.' : ''}`
        : result;
      if (noopWrite) consecutiveNoopWrites++;
      opts.events.onToolEnd({ ...event, ok, result: reported });
      results.push(formatToolResult(tool.name, reported, ok && !noopWrite));

      if (change) {
        recordChange(change);
        knownProjectFiles.add(change.path.replace(/^\.\//, ''));
      }
      // A successful test/build command run by the model counts as its own
      // verification; an `ls` or `echo` does not.
      if (
        ok &&
        tool.name === 'Bash' &&
        VERIFYISH_COMMAND.test(String(input.command ?? '')) &&
        !requestRequiresExecution(prompt)
      ) {
        unverified = [];
        verifyState.last = true;
      }
    }

    if (toolCalls.length > MAX_CALLS_PER_TURN) {
      results.push(
        `Note: only the first ${MAX_CALLS_PER_TURN} tool calls were executed. Request the others again if still needed.`,
      );
    }
    if (opts.signal?.aborted) {
      status = 'aborted';
      break;
    }

    // Three identical resends with no real change in between: more turns
    // will not produce different bytes. Stop honestly.
    if (consecutiveNoopWrites >= 3) {
      opts.events.onStatus?.(
        '⚠ The model re-sent content identical to the current files 3 times — stopping.',
      );
      if (verifyState.last === false) status = 'requirements-unmet';
      break;
    }

    // In assisted mode the code-block fallback ends the turn — the student
    // decides what happens next. Auto mode verifies and continues. A cheap
    // read-only syntax check still runs so a broken applied file is flagged
    // NOW instead of when the student runs it (advisory: no model retries,
    // nothing executed).
    if (assistedCodeblockOnly) {
      const applied = [...new Set(unverified)];
      const cmd = applied.length ? syntaxCheckCommand(applied) : null;
      if (cmd) {
        const { ok, output } = await runVerification(cmd, opts.projectDir, opts.signal);
        if (!ok) {
          const detail = output.trim().split('\n').slice(-3).join('\n');
          opts.events.onStatus?.(
            `⚠ Syntax check failed for ${applied.join(', ')} — the applied file does not parse:\n${detail}`,
          );
        } else {
          // Syntax is fine — also flag NameError-class typos ("for I in
          // nums" loading i) that py_compile can never see. Advisory only.
          const nameCmd = undefinedNameCheckCommand(applied);
          if (nameCmd) {
            const nameCheck = await runVerification(nameCmd, opts.projectDir, opts.signal);
            if (!nameCheck.ok && nameCheck.output.includes('possibly undefined')) {
              opts.events.onStatus?.(
                `⚠ Possibly undefined name — this usually crashes at runtime:\n${nameCheck.output.trim().split('\n').slice(0, 3).join('\n')}`,
              );
            }
          }
        }
      }
      break;
    }

    await harnessVerify(results);
    if (stuckOnIdenticalError) {
      status = 'requirements-unmet';
      opts.events.onStatus?.(
        '⚠ Verification failed with the identical error 3 times — stopping. The last error output is shown above.',
      );
      break;
    }
    messages.push({ role: 'user', content: results.join('\n\n') });

    if (turn === MAX_TURNS - 1) {
      status = 'turn-limit';
      opts.events.onText(turnLimitMessage(opts.language));
    }
  }

  const netChanges: NetChange[] = [...netState.entries()]
    .filter(([, s]) => s.before !== s.after || !s.existedBefore)
    .map(([path, s]) => ({ path, before: s.before, after: s.after, existedBefore: s.existedBefore }));

  // Convention: `verified` is the last check's outcome, valid only while it
  // covers the current state. Changes a verifier could never apply to are
  // dropped from the dirty set in harnessVerify; changes that COULD be
  // checked but were not (budget exhausted, early stop) downgrade a stale
  // true → false. Null means no verification was ever applicable.
  const verified =
    unverified.length && verifyState.last !== null ? false : verifyState.last;

  if (status === 'completed' && requestExpectsChanges(prompt) && changes.length === 0) {
    status = 'no-change';
    opts.events.onStatus?.('⚠ The request expected a file change, but no applicable change was produced.');
  }

  if (verified === false) {
    opts.events.onStatus?.('⚠ Changes were not successfully verified when the agent stopped.');
  }

  return {
    history: messages,
    finalText,
    changes,
    status,
    verified,
    verification: verifyState.evidence,
    netChanges,
    // Unfulfilled change-expecting request: the next bare "yes" resumes it.
    pendingIntent:
      requestExpectsChanges(prompt) && changes.length === 0 && status !== 'aborted'
        ? prompt
        : null,
  };
}
