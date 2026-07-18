import { stat } from 'node:fs/promises';
import { setTimeout as sleepMs } from 'node:timers/promises';
import type { MinervaClient } from '../api/client.js';
import { MinervaModelAdapter, type ModelAdapter } from '../model/index.js';
import type { ChatMessage } from '../types.js';
import { getTool, getTools } from '../tools/registry.js';
import { resolveInProject, type Tool } from '../tools/tool.js';
import type { AppliedChange, ChangeLog } from './context.js';
import {
  classifyRequest,
  isBareAffirmation,
  isConversationalPrompt,
  requestRequiresExecution,
  type RequestIntent,
} from './intent.js';
import {
  mergePartialWrite,
  protectedDefinitionNames,
  removedTopLevelDefinitions,
} from './merge.js';
import { evaluateOutput } from './oracles/index.js';
import { parseToolCalls } from './parser.js';
import { needsApproval, type PermissionMode } from './permissions.js';
import { buildPreview, filePatch, readIfExists } from './preview.js';
import type { NetChange } from './rollback.js';
import { runReviewWithModel } from './review.js';
import {
  detectVerifyCommand,
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
/** Consecutive transient model-request failures tolerated per request. */
export const MODEL_RETRIES_PER_TURN = 2;
const MODEL_RETRY_BACKOFF_MS = 1_500;

/**
 * One model request with the shared transient-failure policy: up to
 * MODEL_RETRIES_PER_TURN consecutive retries with a short backoff. The
 * request is idempotent — nothing is appended to the conversation until it
 * succeeds. On a slow public endpoint a long run sees several independent
 * stalls, so the budget applies per request, not per run.
 */
async function streamChatWithRetry(
  model: ModelAdapter,
  messages: ChatMessage[],
  opts: AgentOptions,
): Promise<
  { ok: true; text: string; sources: unknown[] } | { ok: false; message: string }
> {
  let retries = MODEL_RETRIES_PER_TURN;
  for (;;) {
    try {
      const sources: unknown[] = [];
      const text = await model.send(
        { messages, signal: opts.signal, webSearch: opts.webSearch },
        opts.webSearch
          ? (event) => {
              if (event.type === 'sources') sources.push(...event.sources);
            }
          : undefined,
      );
      return { ok: true, text, sources };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (retries <= 0 || opts.signal?.aborted) {
        opts.events.onStatus?.(`⚠ Model request failed: ${message}`);
        return { ok: false, message };
      }
      retries--;
      opts.events.onStatus?.(`⚠ Model request failed: ${message} — retrying…`);
      // Resolve-on-abort: an aborted wait just proceeds to the aborted check.
      await sleepMs(MODEL_RETRY_BACKOFF_MS, undefined, { signal: opts.signal }).catch(() => {});
    }
  }
}

/**
 * Best-effort URLs out of Open WebUI's `sources` payload shape (an array of
 * `{ source: { urls: [...] }, ... }` entries). Falls back to a bare count
 * when the shape does not match — still proof search ran, just not which.
 */
function summarizeSources(sources: unknown[]): string {
  const urls = new Set<string>();
  for (const entry of sources) {
    const list = (entry as { source?: { urls?: unknown } } | null)?.source?.urls;
    if (Array.isArray(list)) {
      for (const url of list) if (typeof url === 'string') urls.add(url);
    }
  }
  if (!urls.size) return `${sources.length} source${sources.length === 1 ? '' : 's'}`;
  const shown = [...urls].slice(0, 5);
  return shown.join(', ') + (urls.size > shown.length ? `, +${urls.size - shown.length} more` : '');
}

/**
 * `webSearch: true` only means the CLI ASKED Open WebUI to search — the
 * server silently ignores the flag when the capability is missing on the
 * account, the model, or the instance config. A `sources` SSE line is the
 * only proof a search tool actually ran; its absence must be reported as
 * loudly as a failed verification, not assumed away.
 */
function reportWebSearch(opts: AgentOptions, sources: unknown[]): void {
  if (!opts.webSearch) return;
  opts.events.onStatus?.(
    sources.length
      ? `🔎 Web search ran: ${summarizeSources(sources)}`
      : '⚠ Web search was requested but the server returned no sources for this turn — it was likely ignored (check that web search is enabled for this model on Chat Minerva).',
  );
}
const AGENT_ACKNOWLEDGEMENT =
  'Understood. I will act directly with the available tools, create explicitly requested new files, and verify the real result before reporting completion.';

/** Commands that count as the model verifying its own changes. */
const VERIFYISH_COMMAND =
  /\b(?:pytest|unittest|py_compile|(?:npm|pnpm|yarn|bun)\s+(?:test|run)|vitest|jest|node --test|tsc|mypy|ruff|flake8|make|cargo (?:test|check|build)|go (?:test|build)|mvn|gradle|gcc|cc|clang|g\+\+|javac)\b/;

/**
 * The deterministic guards that can reject a tool call. A stable name per
 * guard is what the repeated-refusal bail-out counts, so it measures "this
 * guardrail keeps firing" rather than "this exact sentence keeps repeating".
 */
export type GuardName =
  | 'truncated-write'
  | 'required-path-substitution'
  | 'incomplete-c-program'
  | 'unrequested-new-file'
  | 'unrequested-test-edit'
  | 'definition-removal';

/** Paths that look like test files (pytest/unittest/jest/vitest conventions). */
export const TEST_FILE_PATH =
  /(^|\/)(?:test_[^/]+\.[a-z0-9]+|[^/]+_test\.[a-z0-9]+|[^/]+\.(?:test|spec)\.[a-z0-9]+)$|(^|\/)tests?\//i;

const SOURCE_FILE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp)$/i;

/**
 * Compatibility re-exports. Prompt classification moved to ./intent.js;
 * these keep the agent loop's published surface intact for callers and
 * tests that predate that boundary.
 */
export {
  classifyRequest,
  requestAllowsNewFile,
  requestAllowsTestEdit,
  requestExpectsChanges,
  requestExplicitSourcePaths,
  requestRequiredDefinitions,
  requestRequiredDefinitionsWithConfidence,
  type RequestIntent,
  type RequiredDefinition,
  type RequirementConfidence,
} from './intent.js';
export { isBareAffirmation, isConversationalPrompt, requestRequiresExecution };

/** Does this file content define (not merely call) the named function? */
export function definesIdentifier(content: string, name: string): boolean {
  return new RegExp(
    String.raw`\b(?:def|function|func|fn)\s+${name}\s*\(` +
      String.raw`|(?:const|let|var)\s+${name}\s*=` +
      String.raw`|class\s+${name}\b` +
      String.raw`|\b(?:int|void|double|float|char|bool|long|unsigned)\s+\**${name}\s*\(`,
  ).test(content);
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
  /**
   * Open WebUI web search for this run (`features.web_search`). Off by
   * default — the Chat Minerva 7B often lacks the capability and search
   * adds latency even when the server supports it.
   */
  webSearch?: boolean;
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
/** Does any changed Python file actually read from stdin? */
function readsUserInput(contents: string[]): boolean {
  return contents.some((c) => /\binput\s*\(|\bsys\.stdin\b|\braw_input\s*\(/.test(c));
}

/**
 * Any file whose CONTENT a student may ask about — source, web, config,
 * notes. A directory holding any of these keeps every message on the agent
 * path, where the Read tool exists.
 */
const CONTENT_FILE_PATH =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp|rb|php|kt|swift|cs|sh|bash|zsh|html?|css|scss|sql|md|txt|json|ya?ml|toml|csv|ipynb)$/i;

/**
 * A message with no change request, no run request, and no reference to the
 * project, code, or any file — "quanto fa 2+2?", "spiega la ricorsione" —
 * sent from a directory that holds no readable content files (the
 * chat-client case). The full agent scaffold (rules, tools, repository map)
 * measurably derails a 7B on these; they get a plain chat turn instead.
 * With content files present, even terse messages stay on the agent path:
 * "Count x up." is a coding instruction, not small talk.
 */
export function isConversationalRequest(prompt: string, projectFiles: string[]): boolean {
  if (!isConversationalPrompt(prompt)) return false;
  if (projectFiles.some((file) => CONTENT_FILE_PATH.test(file))) return false;
  const lower = prompt.toLowerCase();
  return !projectFiles.some((file) => {
    const base = file.split('/').at(-1)?.toLowerCase();
    return base && base.length > 2 && lower.includes(base);
  });
}

/**
 * Plain chat turn: no agent rules, no tools, no repository context. The
 * persona wrapper is sent to the model but NOT persisted — later agent
 * turns must replay only the student's actual words, and a failed request
 * must not leave an orphaned user message in history.
 */
async function runLightChat(
  model: ModelAdapter,
  opts: AgentOptions,
  prompt: string,
): Promise<AgentResult> {
  const instructions = `You are Minerva, a friendly AI assistant for students, chatting in a plain terminal. ${languageInstruction(opts.language)} Answer the student's message directly and concisely.`;
  const history = scrubStaleAssistantFences(opts.history);
  const result = await streamChatWithRetry(
    model,
    [...history, { role: 'user', content: `${instructions}\n\nStudent message: ${prompt}` }],
    opts,
  );
  if (!result.ok) {
    return {
      history: opts.history,
      finalText: result.message,
      changes: [],
      status: 'model-error',
      verified: null,
      verification: null,
      netChanges: [],
      pendingIntent: opts.pendingIntent ?? null,
    };
  }
  reportWebSearch(opts, result.sources);
  opts.events.onText(result.text);
  return {
    history: [
      ...history,
      { role: 'user', content: prompt },
      { role: 'assistant', content: result.text },
    ],
    finalText: result.text,
    changes: [],
    status: 'completed',
    verified: null,
    verification: null,
    netChanges: [],
    pendingIntent: opts.pendingIntent ?? null,
  };
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

/**
 * The agent core, against any ModelAdapter. Nothing below reaches for a
 * provider: every model request goes through `model.send`, and the advisory
 * review runs on the SAME adapter, so a non-Minerva run stays non-Minerva
 * end to end.
 *
 * Prompt construction is still written for the Minerva harness profile —
 * `buildSystemPrompt` output rides in a user message because Open WebUI drops
 * system-role messages (see ModelCapabilities.systemRole). That placement is
 * currently unconditional. Making it capability-driven is deferred: it would
 * change the live Minerva prompts, which are tuned against a benchmark, and
 * no second adapter exists yet to validate the alternative against. See the
 * note on `systemRole` in ../model/types.ts.
 */
export async function runAgentWithModel(
  model: ModelAdapter,
  opts: AgentOptions,
): Promise<AgentResult> {
  const tools = getTools();
  const auto = opts.permissionMode === 'dontAsk';
  // "yes" carries no task: every gate below keys on the prompt, so a bare
  // go-ahead resumes the stored unfulfilled request instead.
  const prompt =
    opts.pendingIntent && isBareAffirmation(opts.prompt) ? opts.pendingIntent : opts.prompt;
  // Every deterministic gate below judges the SAME words: classify once so a
  // long run cannot disagree with itself halfway through.
  const intent: RequestIntent = classifyRequest(prompt);
  // Prompt gates first — the directory walk only runs for messages that
  // could actually be small talk, so coding requests pay nothing extra.
  if (
    isConversationalPrompt(prompt) &&
    isConversationalRequest(prompt, await listProjectFiles(opts.projectDir))
  ) {
    return runLightChat(model, opts, prompt);
  }
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
  const requiredNewPaths = intent.allowsNewFile
    ? intent.explicitSourcePaths.filter((file) => !knownProjectFiles.has(file))
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
  // Detected by content, not history length: light-chat turns add history
  // without ever injecting the agent instructions.
  const firstTurn = !opts.history.some(
    (message) =>
      message.role === 'user' && message.content.includes('You are Minerva, a programming agent'),
  );
  let initialVerification: { command: string; output: string } | undefined;
  if (auto && firstTurn && intent.expectsChanges) {
    const cmd = await detectVerifyCommand(opts.projectDir, projectFiles, []);
    if (cmd && /test|pytest|unittest|\.minervacode\.md/i.test(cmd.source)) {
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
    intent.requiresExecution &&
    requiredNewPaths.some((file) => /\.(?:c|cc|cpp|cxx)$/i.test(file));
  const acceptanceRequirements = requiredNewPaths.length
    ? `\n\nHard acceptance requirement: create the exact requested path${requiredNewPaths.length === 1 ? '' : 's'} ${requiredNewPaths.join(', ')}. Do not substitute another filename.${intent.requiresExecution ? ' This is a small standalone program: keep each file under 80 lines, use direct standard-language control flow, and emit the complete file action now before any explanation.' : ''}${requestedCProgram ? ' C/C++ hygiene: use a conventional main entry point, include every standard header you use, keep identifier casing consistent, and prefer small bounded loops and helpers over recursion, variable-length arrays, or pointer tricks.' : ''}`
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
  // Guardrail refusals carry their own correction text; a model that trips
  // the SAME one three times is not converging — more turns are just noise.
  // Keyed by GUARD, not by message: the text embeds the offending path, so
  // string keys let a model evade the bail-out by cycling filenames.
  const refusalCounts = new Map<GuardName, number>();
  let repeatedRefusal: string | null = null;
  let requirementsNudges = 0;
  let missingDefNudges = 0;
  let likelyDefsWarned = false;
  let inputNudges = 0;
  /** Source files a run-this request changed but no verifier could check. */
  const unverifiableExecution = new Set<string>();
  // Names the request demands. Only `certain` ones (an explicit "a function
  // f(x)" cue) may fail the run; `likely` ones are inferred from bare call
  // syntax, which prose also uses for examples — see ./intent.js.
  const requiredDefs = intent.expectsChanges ? intent.requiredDefinitionNames : [];
  const certainRequiredDefs = intent.expectsChanges
    ? intent.certainRequiredDefinitions
    : [];
  const requiresUserInput = intent.expectsChanges && intent.expectsUserInput;
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
    // A failing response is the moment a 7B most needs LESS context. The
    // full agent prompt is useful for discovery, but replaying its long rule
    // list alongside a traceback made the model narrate repairs or preserve
    // its broken abstraction. Rebuild a one-shot, file-grounded replacement
    // request instead: the parser applies the labelled fence deterministically.
    messages = [
      {
        role: 'user',
        content: `${languageInstruction(opts.language)}\n\nRepair the current source file now. Return exactly one complete replacement file, with the filename on its own line immediately before one fenced code block. Do not explain, apologize, ask a question, show commands, or include partial snippets. For a small standalone program, prefer simple top-level code and standard-library features.\n\nOriginal student request: ${prompt}\n${requiredNewPaths.length ? `Required output path: ${requiredNewPaths.join(', ')}\n` : ''}\nCurrent source (authoritative):\n${currentFiles.join('\n\n')}\n\nReal verification failure:\n$ ${command}\n${output}`,
      },
    ];
  };

  const recordChange = (change: FileChange) => {
    const trackedPath = change.path.replace(/^\.\//, '');
    changeSerial++;
    consecutiveNoopWrites = 0;
    // Real progress breaks a refusal streak — only an uninterrupted run of
    // identical refusals means the model is stuck.
    refusalCounts.clear();
    repeatedRefusal = null;
    changes.push({ path: change.path, patch: change.patch });
    opts.changeLog?.add({ path: change.path, patch: change.patch });
    // `./main.py` and `main.py` are the same file. Canonicalize internal
    // verification/net tracking so a repair with different spelling does not
    // look like two changed Python files and fall back to a syntax-only check.
    unverified.push(trackedPath);
    const net = netState.get(trackedPath);
    if (net) {
      net.after = change.after;
    } else {
      netState.set(trackedPath, {
        before: change.before,
        after: change.after,
        existedBefore: change.existedBefore,
      });
    }
  };

  /**
   * Reject one tool call: report it, count it against its guard, and hand
   * the model the correction. Every guard refuses the same way, so the
   * bail-out sees a consistent identity for each.
   */
  const refuse = (
    guard: GuardName,
    tool: Tool,
    input: Record<string, unknown>,
    message: string,
    results: string[],
  ) => {
    opts.events.onToolEnd({
      tool,
      input,
      summary: tool.summarize(input),
      ok: false,
      result: message,
    });
    const count = (refusalCounts.get(guard) ?? 0) + 1;
    refusalCounts.set(guard, count);
    if (count >= 3) repeatedRefusal = message;
    results.push(formatToolResult(tool.name, message, false));
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
      // But when the request explicitly asked to RUN the result and these
      // are source files (a language with no available toolchain), silence
      // must not read as success: remember them and fail honestly at the end.
      const sources = [...new Set(unverified)].filter((file) => SOURCE_FILE_PATH.test(file));
      if (sources.length && intent.requiresExecution) {
        for (const file of sources) unverifiableExecution.add(file);
      }
      unverified = [];
      return false;
    }

    // A green project test/build is useful evidence, but it does not prove an
    // explicitly requested program was actually run. Remember source files
    // covered only by such an indirect check so they cannot leave auto mode
    // behind a false-success result (for example main.go plus an unrelated
    // package.json test script).
    if (intent.requiresExecution && cmd.source !== 'compile and run') {
      for (const file of [...new Set(unverified)]) {
        if (SOURCE_FILE_PATH.test(file)) unverifiableExecution.add(file);
      }
    }

    verifyRuns++;
    const bash = getTool('Bash');
    const event: ToolCallEvent | null = bash
      ? { tool: bash, input: { command: cmd.command }, summary: compactCommand(cmd.command) }
      : null;
    opts.events.onStatus?.(`Verifying changes (${cmd.source}): ${compactCommand(cmd.command)}`);
    if (event) opts.events.onToolStart(event);
    const raw = await runVerification(cmd, opts.projectDir, opts.signal);
    // A compile-and-run pass proves the program runs, NOT that it is
    // correct. The oracles catch what the exit code cannot: a "first 20
    // primes" run emitting twenty 2s, a median() that prints the wrong
    // number. Only a program the harness actually RAN has output to judge.
    const verdict =
      raw.ok && cmd.source === 'compile and run'
        ? evaluateOutput(prompt, raw.output)
        : null;
    const ok = verdict ? false : raw.ok;
    const output = verdict ? `${raw.output}\n\n${verdict.guidance}` : raw.output;
    if (event) opts.events.onToolEnd({ ...event, ok, result: output });

    verifyState.last = ok;
    // The evidence shown to students should identify what ran without
    // dumping internal here-doc probe machinery into their transcript.
    verifyState.evidence = { command: compactCommand(cmd.command), output, source: cmd.source, ok };
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
      // Multi-line verification commands can contain harness implementation
      // (for example the Python input probe). Never let a weak model mistake
      // that machinery for source it should paste into the student's file.
      await focusFailedRepair(compactCommand(cmd.command), output);
    }
    const guidance = ok
      ? 'Verification passed. If the request is complete, briefly summarize what you changed — do not repeat file contents.'
      : `This verification command failed. Use the REAL error output above and apply a source fix now — do not merely explain it, do not weaken tests, and do not send partial snippets.${requiredNewPaths.length ? ` Replace the required ${requiredNewPaths.join(', ')} with a complete minimal implementation when a whole-file rewrite is needed.` : ''} The check will run again only after a file changes.`;
    results.push(
      `${formatToolResult('Bash', `$ ${compactCommand(cmd.command)}\n${output}`, ok)}\n\n${guidance}`,
    );
    return true;
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    compactContext();
    const attempt = await streamChatWithRetry(model, messages, opts);
    if (!attempt.ok) {
      status = 'model-error';
      finalText = attempt.message;
      break;
    }
    const response = attempt.text;
    reportWebSearch(opts, attempt.sources);
    messages.push({ role: 'assistant', content: response });

    // The code-block fallback is the primary write path for ChatMinerva —
    // the model proposes whole files in fences rather than emitting tool
    // blocks. Permission mode still gates whether the Write auto-applies.
    const { toolCalls, text, suspectTruncated } = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: projectFiles,
      preferredFiles: intent.expectsChanges
        ? requiredNewPaths.length
          ? requiredNewPaths
          : repoMap.contextFiles.filter((file) => !TEST_FILE_PATH.test(file))
        : undefined,
      // In assisted mode the student approves every proposed Write, so a
      // best-guess target for a filename-less fence beats a dead end.
      guessPreferredFile: !auto,
      // "Write me a script …" against an empty project: default to main.py
      // (& co.) so the first reply's code is applied instead of dropped.
      fallbackNewFile: intent.expectsChanges,
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
      // Preserve explicit malformed-output signals even for terse requests
      // ("Set y", "Bump config") that the intent classifier may not catch.
      // UI hallucinations also take precedence over the question detector:
      // "If you want, click Show Code" is not a real clarification.
      if (
        !nudged &&
        !changes.length &&
        (response.includes('```') ||
          ACTION_CLAIM.test(response) ||
          UI_CLAIM.test(response) ||
          (intent.expectsChanges && UNFENCED_CODE.test(response)))
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
        intent.expectsChanges &&
        isQuestionOnlyReply(response)
      ) {
        questionNudged = true;
        messages.push({
          role: 'user',
          content: `Yes. Do not ask further questions — proceed with your best interpretation now. Emit the complete file: the filename on its own line, then one fenced code block with the COMPLETE contents.\nOriginal request: ${prompt}`,
        });
        continue;
      }

      // Classify failure structurally, not by refusal wording. Any mutating
      // request that produced neither a tool call nor an applied fallback
      // gets one corrected-format retry. This catches generic apologies,
      // empty/prose-only replies, and unrecognized malformed output in every
      // language without an open-ended list of refusal phrases.
      if (!nudged && !changes.length && intent.expectsChanges) {
        nudged = true;
        messages.push({
          role: 'user',
          content: formatNudge(projectFiles, requiredNewPaths),
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
      const isMissing = (name: string) =>
        ![...netState.values()].some(
          (s) => definesIdentifier(s.after, name) || definesIdentifier(s.before, name),
        );
      const missingDefs = auto ? requiredDefs.filter(isMissing) : [];
      if (missingDefs.length) {
        if (missingDefNudges < 2) {
          missingDefNudges++;
          messages.push({
            role: 'user',
            content: `The request explicitly requires defining ${missingDefs.map((n) => `${n}(...)`).join(', ')} and the current changes do not define ${missingDefs.length === 1 ? 'it' : 'them'}. Emit a Write or Edit now that adds the missing definition${missingDefs.length === 1 ? '' : 's'} without removing existing code.`,
          });
          continue;
        }
        // Nudging is cheap and worth doing for any named function. FAILING
        // the run is not: a `likely` requirement is inferred from bare call
        // syntax, which prose also uses for examples and glosses, so
        // rejecting on one would discard work that verifiably does the task.
        // Only an explicit "a function f(x)" cue is firm enough to fail on.
        const missingCertain = certainRequiredDefs.filter(isMissing);
        if (missingCertain.length) {
          status = 'requirements-unmet';
          opts.events.onStatus?.(
            `⚠ Required function${missingCertain.length === 1 ? '' : 's'} ${missingCertain.join(', ')} ${missingCertain.length === 1 ? 'was' : 'were'} never defined.`,
          );
          break;
        }
        if (!likelyDefsWarned) {
          likelyDefsWarned = true;
          opts.events.onStatus?.(
            `⚠ The request may also have asked for ${missingDefs.join(', ')}, which the changes do not define — check whether you still need ${missingDefs.length === 1 ? 'it' : 'them'}.`,
          );
        }
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
          const review = await runReviewWithModel(model, {
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

    // The parser tags the exact Write produced from the auto-closed fence;
    // an earlier complete write in the same reply is never blamed.
    const truncatedCall = suspectTruncated
      ? toolCalls.find((c) => c.suspectTruncated)
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
          refuse(
            'truncated-write',
            tool,
            input,
            `Refused: your reply was cut off mid-file, so this Write to ${input.path} is likely incomplete. Resend the COMPLETE ${input.path} in one fenced code block, nothing after it.`,
            results,
          );
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
        refuse(
          'required-path-substitution',
          tool,
          input,
          `Refused: the request explicitly requires ${requiredNewPaths.join(', ')}, not ${input.path}. Create the exact requested path and do not invent an alternative source filename.`,
          results,
        );
        continue;
      }

      if (
        auto &&
        tool.name === 'Write' &&
        normalizedInputPath &&
        requiredNewPaths.includes(normalizedInputPath) &&
        intent.requiresExecution &&
        /\.(?:c|cc|cpp|cxx)$/i.test(normalizedInputPath) &&
        typeof input.content === 'string' &&
        !/\b(?:int|void)\s+main\s*\([^)]*\)\s*\{/s.test(input.content)
      ) {
        refuse(
          'incomplete-c-program',
          tool,
          input,
          `Refused: ${input.path} is the requested executable program, but this Write is only a partial snippet and has no complete main function. Send the COMPLETE ${input.path} file in one Write (or use Edit for a focused replacement).`,
          results,
        );
        continue;
      }

      if (
        auto &&
        (tool.name === 'Write' || tool.name === 'Edit') &&
        typeof input.path === 'string' &&
        !knownProjectFiles.has(input.path.replace(/^\.\//, '')) &&
        projectHasSourceFiles &&
        !intent.allowsNewFile
      ) {
        refuse(
          'unrequested-new-file',
          tool,
          input,
          `Refused: ${input.path} does not exist and this request did not ask to create files. Fix the relevant existing source files; do not invent unrelated files.`,
          results,
        );
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
        !intent.allowsTestEdit(input.path)
      ) {
        refuse(
          'unrequested-test-edit',
          tool,
          input,
          `Refused: ${input.path} is a test file and the request did not ask to change tests. The existing tests define the expected behavior — fix the SOURCE files so they pass.`,
          results,
        );
        continue;
      }

      // Preserve-bias (partial-write merging, refusing definition removal)
      // protects the STUDENT's pre-existing work. A file this run created
      // has none — merging or refusing there only traps the model with its
      // own broken first draft instead of letting it rewrite cleanly.
      const normalizedNetPath =
        typeof input.path === 'string' ? input.path.replace(/^\.\//, '') : null;
      const netEntry = normalizedNetPath
        ? netState.get(normalizedNetPath) ??
          netState.get(`./${normalizedNetPath}`)
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
        !intent.allowsDefinitionRemoval
      ) {
        try {
          const target = resolveInProject(opts.projectDir, input.path);
          const removed = removedTopLevelDefinitions(
            input.path,
            await readIfExists(target),
            input.content,
          );
          if (removed.length) {
            refuse(
              'definition-removal',
              tool,
              input,
              `Refused: this overwrite would delete unrelated definitions (${removed.join(', ')}). Make a focused replacement and preserve existing functions/classes.`,
              results,
            );
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
        !intent.requiresExecution
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

    // Same guardrail, same refusal, three times: the model is not going to
    // produce the demanded shape. Stop now instead of replaying the loop to
    // the turn limit (observed live: six identical partial-snippet refusals).
    if (auto && repeatedRefusal) {
      status = 'requirements-unmet';
      opts.events.onStatus?.(
        `⚠ The same action was refused 3 times — stopping. Last refusal: ${repeatedRefusal}`,
      );
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
  let verified =
    unverified.length && verifyState.last !== null ? false : verifyState.last;

  // "Compile and run it" with no way to compile or run it is a failure, not
  // a pass-by-default (observed live: a broken .java shipped with exit 0
  // before the harness knew Java). Never claim success that was not checked.
  if (unverifiableExecution.size && verified !== false) {
    verified = false;
    opts.events.onStatus?.(
      `⚠ The request asked to run the program, but no command actually executed ${[...unverifiableExecution].join(', ')} (the toolchain may be missing, or only unrelated test/build checks were available) — the changes are UNVERIFIED.`,
    );
  }

  if (status === 'completed' && intent.expectsChanges && changes.length === 0) {
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
      intent.expectsChanges && changes.length === 0 && status !== 'aborted'
        ? prompt
        : null,
  };
}

/**
 * Compatibility wrapper for callers that hold a MinervaClient. The CLI owns
 * the client's lifecycle (model switching, re-auth), so it keeps passing one
 * rather than an adapter.
 */
export async function runAgent(client: MinervaClient, opts: AgentOptions): Promise<AgentResult> {
  return runAgentWithModel(new MinervaModelAdapter(client), opts);
}
