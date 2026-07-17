/**
 * Prompt classification: everything the agent deterministically infers from
 * the student's words alone, decided once per run.
 *
 * These gates exist because a 7B model cannot be trusted to police itself.
 * Each one is deliberately conservative in the direction that protects the
 * student's existing work, and every regex here encodes an observed live
 * failure — read the comments before widening one.
 */

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
/**
 * Requests can be phrased as questions while still clearly asking us to act:
 * "Why don't you create …?", "What about creating …?", "Perché non crei …?".
 * These must not be swallowed by the broad informational-prefix check above.
 */
const QUESTION_PHRASED_CREATION =
  /^\s*(?:(?:why\s+(?:don'?t|do\s+not)|perch[eé]\s+non)\s+(?:you\s+|tu\s+)?|what\s+about\s+)(?:creat\w*|writ\w*|mak\w*|build\w*|sav\w*|cre[aio]\w*|scriv\w*|costru\w*|salv\w*)\b/i;
const ALLOWS_DEFINITION_REMOVAL =
  /\b(?:remov\w*|delet\w*|rewrit\w*|replace\w*|refactor\w*|renam\w*|rimuov\w*|elimina\w*|riscriv\w*|sostitui\w*|rifattorizz\w*|rinomin\w*)\b/i;

const REQUIRES_EXECUTION =
  /\b(?:run|runs|running|execute|executes|executed|executing|launch|esegu\w*|avvi\w*)\b/i;
const TEST_EXECUTION_PHRASE =
  /\b(?:run|runs|running|execute|executes|executed|executing|esegu\w*|avvi\w*)\s+(?:the\s+|i\s+|gli\s+|la\s+|le\s+)?tests?\b/gi;

/** The request asks for a program that READS USER INPUT. */
const EXPECTS_USER_INPUT =
  /\b(?:chied\w*|inserisc\w*|inserire|ask(?:s|ing)?\b|prompt(?:s|ing)?\s+(?:the\s+)?user)\b/i;

const EXPLICIT_SOURCE_PATH =
  /(?:^|[\s`"'([{])((?:\.\/)?(?:[\w@+.-]+\/)*[\w@+.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cc|cpp|cxx|h|hpp))(?=$|[\s`"',;:!?)\]}]|\.(?:\s|$))/gi;

/** Names that appear with call parens in prose without being the target. */
const COMMON_CALL_NAMES = new Set([
  'print', 'input', 'println', 'printf', 'scanf', 'main', 'len', 'range',
  'str', 'int', 'float', 'bool', 'log', 'console', 'require', 'import',
]);

/** One plausible call argument: a bare identifier, number, string, or list. */
const CALL_ARG = String.raw`(?:-?\d+(?:\.\d+)?|[A-Za-z_]\w*|"[^"]*"|'[^']*'|\[[^\][]*\])`;
/**
 * `name(` with NO space before the paren, and argument-looking contents.
 * Prose parentheticals — "the first 10 Fibonacci numbers (starting 0 1)",
 * "stampa 5 (le vocali di …)" — must never read as demanded functions:
 * observed live, that misparse failed an otherwise-correct run.
 */
const SPELLED_CALL = new RegExp(
  String.raw`\b([A-Za-z_]\w*)\((\s*(?:${CALL_ARG}(?:\s*,\s*${CALL_ARG})*\s*)?)\)`,
  'g',
);
/**
 * An explicit definition cue allows spaces and arbitrary argument text:
 * "una funzione somma (a, b)", "a function fib(n - 1)".
 */
const DEF_CUE_CALL = /\b(?:functions?|methods?|funzion[ei]|metod[oi]|def)\s+([A-Za-z_]\w*)\s*\(/gi;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
};
const COUNTED_NUMBER_REQUEST = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci)\s+(?:numbers?|integers?|numeri)\b/i;
/** Upper bound on probe values the harness is willing to feed a program. */
const MAX_PROBE_COUNT = 10;

/**
 * Anything that ties the message to the project or to code work. Kept broad
 * on purpose: routing a coding question through the full agent is harmless,
 * routing a coding task through bare chat loses the tools.
 */
const PROJECT_REFERENCE =
  /\b(?:files?|folders?|director(?:y|ies)|projects?|repo(?:s|sitory|sitories)?|code|codebase|tests?|specs?|bugs?|errors?|exceptions?|programs?|scripts?|functions?|methods?|class(?:es)?|variables?|modules?|imports?|compil\w*|debug\w*|refactor\w*|install\w*|dependen\w*|homework|exercises?|assignments?|cartell\w*|progett\w*|codice|error[ei]?|eccezion\w*|programm\w*|funzion\w*|metod[oi]|class[ei]|variabil\w*|modul[oi]|compit[oi]|eserciz\w*|consegn\w*)\b/i;

/** A token that looks like a filename ("utils.py", "Main.java"). */
const FILENAME_TOKEN = /\b[\w-]+\.[a-z][a-z0-9]{0,4}\b/i;

/**
 * Creation/coding vocabulary that must stay on the agent path even when the
 * change-verb gate is defeated by question phrasing ("Perché non crei tu un
 * piccolo gioco in Python e lo salvi qui?").
 */
const CODE_OR_CREATE_REFERENCE =
  /\b(?:cre[aio]\w*|scriv\w*|salv\w*|writ\w*|creat\w*|sav\w*|build\w*|mak\w*|fix\w*|corregg\w*|python|java\w*|c\+\+|c#|html|css|sql|bash|quiz|gioco|game|app|pagina|sito|web\w*|navbar)\b/i;

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Bilingual glosses — "in ordine crescente(ascending)", "la media(average)"
 * — look exactly like a call with one identifier argument. A lone word-arg
 * only counts when something signals real code: an underscore/digit/camelCase
 * in the callee name, or a short variable-like argument ("fib(n)").
 */
function looksLikeGloss(name: string, args: string): boolean {
  const arg = args.trim();
  if (!/^[A-Za-z]+$/.test(arg) || arg.length <= 2) return false;
  return /^[a-z]+$/.test(name);
}

/**
 * How firmly the request demands a named definition.
 *
 * `certain` — an explicit definition cue ("add a function is_even(n)").
 * `likely`  — inferred from bare call syntax in prose ("print gcd(12, 18)"),
 *             which is also how prompts write examples and glosses.
 *
 * Only `certain` may fail a run: a `likely` false positive would reject an
 * otherwise correct, verified program, which is the worse error.
 */
export type RequirementConfidence = 'certain' | 'likely';

export interface RequiredDefinition {
  readonly name: string;
  readonly confidence: RequirementConfidence;
}

/** Everything inferable from the request text, computed once per run. */
export interface RequestIntent {
  /** The effective request these conclusions were drawn from. */
  readonly prompt: string;
  readonly expectsChanges: boolean;
  readonly allowsNewFile: boolean;
  readonly allowsDefinitionRemoval: boolean;
  readonly requiresExecution: boolean;
  readonly expectsUserInput: boolean;
  /** Source paths the student wrote literally, in request order. */
  readonly explicitSourcePaths: readonly string[];
  /** Definitions the request names, each with its confidence. */
  readonly requiredDefinitions: readonly RequiredDefinition[];
  /** All required names regardless of confidence, in request order. */
  readonly requiredDefinitionNames: readonly string[];
  /** Names firm enough to fail the run when never defined. */
  readonly certainRequiredDefinitions: readonly string[];
  /** Names worth a nudge, but never a rejection. */
  readonly likelyRequiredDefinitions: readonly string[];
  /** Count of interactive integers the program should read, if stated. */
  readonly requestedNumberCount: number | null;
  /** Does the request authorize touching this specific test file? */
  allowsTestEdit(testPath: string): boolean;
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
    QUESTION_PHRASED_CREATION.test(prompt) ||
    (!INFORMATIONAL_REQUEST.test(prompt) &&
      (EXPECTS_FILE_CHANGES.test(prompt) || PROGRAM_SPEC.test(prompt)))
  );
}

export function requestRequiresExecution(request: string): boolean {
  // "Run the tests" asks for verification, not for executing a changed
  // source module as a standalone program.
  return REQUIRES_EXECUTION.test(request.replace(TEST_EXECUTION_PHRASE, ''));
}

export function requestExpectsUserInput(prompt: string): boolean {
  return EXPECTS_USER_INPUT.test(prompt);
}

export function requestAllowsDefinitionRemoval(prompt: string): boolean {
  return ALLOWS_DEFINITION_REMOVAL.test(prompt);
}

/** Source paths the student wrote literally in the request, in request order. */
export function requestExplicitSourcePaths(prompt: string): string[] {
  const paths = [...prompt.matchAll(EXPLICIT_SOURCE_PATH)].map((match) =>
    match[1].replace(/^\.\//, ''),
  );
  return [...new Set(paths)];
}

/**
 * Function names the request spells out, each tagged with how firmly it was
 * demanded. Request order: bare call syntax first, then definition cues that
 * did not already appear — a name demanded both ways is `certain`.
 */
export function requestRequiredDefinitionsWithConfidence(prompt: string): RequiredDefinition[] {
  const certain = new Set(
    [...prompt.matchAll(DEF_CUE_CALL)]
      .map((match) => match[1])
      .filter((name) => !COMMON_CALL_NAMES.has(name.toLowerCase())),
  );
  const spelled = [...prompt.matchAll(SPELLED_CALL)]
    .filter((match) => !looksLikeGloss(match[1], match[2]))
    .map((match) => match[1])
    .filter((name) => !COMMON_CALL_NAMES.has(name.toLowerCase()));
  const ordered = [...new Set([...spelled, ...certain])];
  return ordered.map((name) => ({
    name,
    confidence: certain.has(name) ? 'certain' : 'likely',
  }));
}

/**
 * Function names the request spells out with call syntax, e.g. "add a
 * function is_even(n)". A run that never defines them did not do the task,
 * no matter how cleanly its other changes verify.
 */
export function requestRequiredDefinitions(prompt: string): string[] {
  return requestRequiredDefinitionsWithConfidence(prompt).map((def) => def.name);
}

/** Number of requested interactive integers, bounded to a small safe probe. */
export function requestedNumberCount(request: string): number | null {
  const raw = request.match(COUNTED_NUMBER_REQUEST)?.[1]?.toLowerCase();
  if (!raw) return null;
  const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return Number.isInteger(count) && count >= 2 && count <= MAX_PROBE_COUNT ? count : null;
}

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

/** The prompt-only half of the routing gate: cheap, no directory access. */
export function isConversationalPrompt(prompt: string): boolean {
  return (
    !requestExpectsChanges(prompt) &&
    !requestRequiresExecution(prompt) &&
    !PROJECT_REFERENCE.test(prompt) &&
    !CODE_OR_CREATE_REFERENCE.test(prompt) &&
    !FILENAME_TOKEN.test(prompt)
  );
}

/**
 * Every deterministic conclusion drawn from the request, resolved once so a
 * long run cannot re-classify a prompt halfway through (and so the gates all
 * agree on which words they are judging).
 */
export function classifyRequest(prompt: string): RequestIntent {
  const requiredDefinitions = requestRequiredDefinitionsWithConfidence(prompt);
  const byConfidence = (want: RequirementConfidence) =>
    requiredDefinitions.filter((def) => def.confidence === want).map((def) => def.name);
  return {
    prompt,
    expectsChanges: requestExpectsChanges(prompt),
    allowsNewFile: requestAllowsNewFile(prompt),
    allowsDefinitionRemoval: requestAllowsDefinitionRemoval(prompt),
    requiresExecution: requestRequiresExecution(prompt),
    expectsUserInput: requestExpectsUserInput(prompt),
    explicitSourcePaths: requestExplicitSourcePaths(prompt),
    requiredDefinitions,
    requiredDefinitionNames: requiredDefinitions.map((def) => def.name),
    certainRequiredDefinitions: byConfidence('certain'),
    likelyRequiredDefinitions: byConfidence('likely'),
    requestedNumberCount: requestedNumberCount(prompt),
    allowsTestEdit: (testPath: string) => requestAllowsTestEdit(prompt, testPath),
  };
}
