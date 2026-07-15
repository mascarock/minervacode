import { stat } from 'node:fs/promises';
import type { MinervaClient } from '../api/client.js';
import { streamChat } from '../api/chat.js';
import type { ChatMessage } from '../types.js';
import { getTool, getTools } from '../tools/registry.js';
import { resolveInProject, type Tool } from '../tools/tool.js';
import type { AppliedChange, ChangeLog } from './context.js';
import { mergePartialWrite, removedTopLevelDefinitions } from './merge.js';
import { parseToolCalls } from './parser.js';
import { needsApproval, type PermissionMode } from './permissions.js';
import { buildPreview, filePatch, readIfExists } from './preview.js';
import type { NetChange } from './rollback.js';
import { runReview } from './review.js';
import { detectVerifyCommand, runVerification } from './verify.js';
import { compactMessages } from './compact.js';
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
export const MAX_VERIFY_RUNS = 3;

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
  /\b(?:fix\w*|correct\w*|creat\w*|writ\w*|add\w*|updat\w*|modif\w*|edit\w*|chang\w*|implement\w*|refactor\w*|remove\w*|rename\w*|corregg\w*|sistem\w*|crea\w*|scriv\w*|aggiung\w*|aggiorn\w*|modific\w*|cambi\w*|implementa\w*|rimuov\w*|rinomina\w*)\b/i;
const INFORMATIONAL_REQUEST =
  /^\s*(?:explain|review|inspect|analy[sz]e|describe|why|how|what|show\s+me|spiega|rivedi|analizza|descrivi|perch[eé]|come|cosa)\b/i;
const ALLOWS_DEFINITION_REMOVAL =
  /\b(?:remov\w*|delet\w*|rewrit\w*|replace\w*|refactor\w*|rimuov\w*|elimina\w*|riscriv\w*|sostitui\w*|rifattorizz\w*)\b/i;

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
  return !INFORMATIONAL_REQUEST.test(prompt) && EXPECTS_FILE_CHANGES.test(prompt);
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

export type AgentStatus = 'completed' | 'aborted' | 'turn-limit' | 'no-change';

export interface AgentResult {
  /** Updated conversation history (without the system prompt). */
  history: ChatMessage[];
  finalText: string;
  /** File changes applied during this run. */
  changes: AppliedChange[];
  status: AgentStatus;
  /** Outcome of the last verification run; null when none was needed. */
  verified: boolean | null;
  /** Net first-to-final contents per changed file, for diffs and rollback. */
  netChanges: NetChange[];
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

function turnLimitMessage(language: AgentLanguage = 'auto'): string {
  return language === 'it'
    ? '(Limite di turni raggiunto — riprendi con un nuovo messaggio.)'
    : '(Turn limit reached — continue with a new message.)';
}

/** The model claims to have acted ("I've fixed…") without any tool call. */
const ACTION_CLAIM =
  /\b(?:i(?:'ve| have)?\s+(?:fixed|updated|changed|corrected|modified|implemented)|ho\s+(?:corretto|aggiornato|modificato|sistemato|implementato))\b/i;

/** One-time correction when the model showed code but nothing was applicable. */
function formatNudge(projectFiles: string[]): string {
  const example = projectFiles.find((f) => !f.endsWith('/')) ?? 'main.py';
  return `I could not apply anything from that reply. To change a file, either emit a structured tool call:

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
  const selfReview = opts.review ?? auto;
  opts.events.onStatus?.('Mapping repository context…');
  const [projectContext, repoMap] = await Promise.all([
    loadProjectContext(opts.projectDir),
    buildRepoMap({ projectDir: opts.projectDir, query: opts.prompt }),
  ]);
  const projectFiles = repoMap.files;
  const knownProjectFiles = new Set(projectFiles.map((file) => file.replace(/^\.\//, '')));
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
  if (auto && firstTurn && requestExpectsChanges(opts.prompt)) {
    const cmd = await detectVerifyCommand(opts.projectDir, projectFiles, []);
    if (cmd && /test|pytest|unittest|\.minervacli\.md/i.test(cmd.source)) {
      const bash = getTool('Bash');
      const event: ToolCallEvent | null = bash
        ? { tool: bash, input: { command: cmd.command }, summary: cmd.command }
        : null;
      opts.events.onStatus?.(`Running initial verification (${cmd.source}): ${cmd.command}`);
      if (event) opts.events.onToolStart(event);
      const baseline = await runVerification(cmd, opts.projectDir, opts.signal);
      if (event) opts.events.onToolEnd({ ...event, ok: baseline.ok, result: baseline.output });
      if (!baseline.ok) initialVerification = { command: cmd.command, output: baseline.output };
    }
  }
  const userContent = `${languageInstruction(opts.language)}\n\n${buildTurnPrompt({
    request: opts.prompt,
    repositoryMap: repoMap.map,
    fileContents,
    skippedFiles: skipped,
    initialVerification,
  })}`;

  let messages: ChatMessage[] = [
    ...opts.history,
    ...(firstTurn ? [{ role: 'user' as const, content: instructions }] : []),
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
  const verifyState = { last: null as boolean | null };
  let verifyRuns = 0;
  let nudged = false;
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

  const recordChange = (change: FileChange) => {
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
    // Re-list: the run may have created test files that change the choice.
    const files = await listProjectFiles(opts.projectDir);
    const cmd = await detectVerifyCommand(opts.projectDir, files, unverified);
    if (!cmd) {
      // No verifier applies to these paths (e.g. docs) — they can never be
      // checked, so they must not keep the run marked unverified forever.
      unverified = [];
      return false;
    }

    verifyRuns++;
    const bash = getTool('Bash');
    const event: ToolCallEvent | null = bash
      ? { tool: bash, input: { command: cmd.command }, summary: cmd.command }
      : null;
    opts.events.onStatus?.(`Verifying changes (${cmd.source}): ${cmd.command}`);
    if (event) opts.events.onToolStart(event);
    const { ok, output } = await runVerification(cmd, opts.projectDir, opts.signal);
    if (event) opts.events.onToolEnd({ ...event, ok, result: output });

    verifyState.last = ok;
    // Only a passing check clears the dirty set — a failed one stays due
    // so the stop-branch retries after the model's next fix attempt.
    if (ok) unverified = [];
    const guidance = ok
      ? 'Verification passed. If the request is complete, briefly summarize what you changed — do not repeat file contents.'
      : 'This verification command failed. Diagnose the output above and fix the SOURCE files — do not weaken or delete tests. The check will run again.';
    results.push(
      `${formatToolResult('Bash', `$ ${cmd.command}\n${output}`, ok)}\n\n${guidance}`,
    );
    return true;
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    compactContext();
    const response = await streamChat(client, messages, { signal: opts.signal });
    messages.push({ role: 'assistant', content: response });

    // The code-block fallback is the primary write path for ChatMinerva —
    // the model proposes whole files in fences rather than emitting tool
    // blocks. Permission mode still gates whether the Write auto-applies.
    const { toolCalls, text } = parseToolCalls(response, {
      codeBlockWriteFallback: true,
      knownFiles: projectFiles,
      preferredFiles: requestExpectsChanges(opts.prompt)
        ? repoMap.contextFiles.filter((file) => !TEST_FILE_PATH.test(file))
        : undefined,
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
        (response.includes('```') || ACTION_CLAIM.test(response))
      ) {
        nudged = true;
        messages.push({ role: 'user', content: formatNudge(projectFiles) });
        continue;
      }

      // Changes still unverified when the model stopped — verify them now.
      const pending: string[] = [];
      if (await harnessVerify(pending)) {
        messages.push({ role: 'user', content: pending.join('\n\n') });
        continue;
      }

      // Everything applied and verified — run one self-review pass.
      if (selfReview && auto && netState.size && !reviewed) {
        reviewed = true;
        opts.events.onStatus?.('Reviewing applied changes…');
        const diff = [...netState.entries()]
          .filter(([, s]) => s.before !== s.after)
          .map(([path, s]) => filePatch(path, s.before, s.after))
          .join('\n\n');
        const review = await runReview(client, {
          diff,
          language: opts.language,
          intent: opts.prompt,
          signal: opts.signal,
        });
        opts.events.onText(`Code review:\n${review.raw}`);
        if (review.hasBugs) {
          messages.push({
            role: 'user',
            content: `A code review of your applied changes found these problems:\n\n${review.raw}\n\nFix the [BUG] findings now using tool calls or complete file blocks. Ignore [NIT] findings unless trivial.`,
          });
          continue;
        }
      }
      break;
    }

    const results: string[] = [];
    const assistedCodeblockOnly =
      !auto && toolCalls.every((c) => c.source === 'codeblock');

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

      if (
        auto &&
        (tool.name === 'Write' || tool.name === 'Edit') &&
        typeof input.path === 'string' &&
        !knownProjectFiles.has(input.path.replace(/^\.\//, '')) &&
        projectHasSourceFiles &&
        !requestAllowsNewFile(opts.prompt)
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
        !requestAllowsTestEdit(opts.prompt, input.path)
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

      // A code-block "file" that only re-states some existing functions is
      // a partial update — merge it instead of wiping the rest of the file.
      if (call.source === 'codeblock' && tool.name === 'Write') {
        try {
          const target = resolveInProject(opts.projectDir, String(input.path));
          const merged = mergePartialWrite(
            String(input.path),
            await readIfExists(target),
            String(input.content),
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
        !ALLOWS_DEFINITION_REMOVAL.test(opts.prompt)
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
      opts.events.onToolEnd({ ...event, ok, result });
      results.push(formatToolResult(tool.name, result, ok));

      if (change) {
        recordChange(change);
        knownProjectFiles.add(change.path.replace(/^\.\//, ''));
      }
      // A successful test/build command run by the model counts as its own
      // verification; an `ls` or `echo` does not.
      if (ok && tool.name === 'Bash' && VERIFYISH_COMMAND.test(String(input.command ?? ''))) {
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

    // In assisted mode the code-block fallback ends the turn — the student
    // decides what happens next. Auto mode verifies and continues.
    if (assistedCodeblockOnly) break;

    await harnessVerify(results);
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

  if (status === 'completed' && requestExpectsChanges(opts.prompt) && changes.length === 0) {
    status = 'no-change';
    opts.events.onStatus?.('⚠ The request expected a file change, but no applicable change was produced.');
  }

  if (verified === false) {
    opts.events.onStatus?.('⚠ Changes were not successfully verified when the agent stopped.');
  }

  return { history: messages, finalText, changes, status, verified, netChanges };
}
