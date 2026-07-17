import { outputContainsValue } from './numeric.js';

/**
 * Well-known student functions whose result is fully determined by literal
 * arguments in the request itself ("print median([3, 1, 4, 1, 5])"). Each
 * returns null when the arguments make no sense for it. English and Italian
 * names, same math.
 */
// min/max/sum are deliberately absent: prompts routinely use them as bounds
// or examples in prose ("tra min(1, 100) e max(1, 100)"), where demanding the
// value in the output would fail correct programs. The listed names are only
// ever spelled with literal args when the result itself is the deliverable.
const CANONICAL_FUNCTIONS: Record<string, (args: number[]) => number | null> = {
  median: canonicalMedian,
  mediana: canonicalMedian,
  mean: canonicalMean,
  average: canonicalMean,
  media: canonicalMean,
  factorial: canonicalFactorial,
  fattoriale: canonicalFactorial,
  gcd: canonicalGcd,
  mcd: canonicalGcd,
};

function canonicalMedian(args: number[]): number | null {
  if (!args.length) return null;
  const sorted = [...args].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function canonicalMean(args: number[]): number | null {
  return args.length ? args.reduce((t, v) => t + v, 0) / args.length : null;
}

function canonicalFactorial(args: number[]): number | null {
  if (args.length !== 1 || !Number.isInteger(args[0]) || args[0] < 0 || args[0] > 18) return null;
  let result = 1;
  for (let n = 2; n <= args[0]; n++) result *= n;
  return result;
}

function canonicalGcd(args: number[]): number | null {
  if (args.length < 2 || args.some((v) => !Number.isInteger(v) || v <= 0)) return null;
  return args.reduce((a, b) => {
    while (b) [a, b] = [b, a % b];
    return a;
  });
}

/** Literal numeric arguments: `3, 1.5, -2` or a list `[3, 1, 4]`; else null. */
function parseLiteralCallArgs(raw: string): number[] | null {
  const inner = raw.trim().replace(/^\[(.*)\]$/s, '$1');
  if (!inner.trim()) return null;
  const parts = inner.split(',').map((part) => part.trim());
  const values: number[] = [];
  for (const part of parts) {
    if (!/^-?\d+(?:\.\d+)?$/.test(part)) return null;
    values.push(Number(part));
  }
  return values;
}

/**
 * The request spells out calls to well-known functions with literal
 * arguments — their expected values are computable here, exactly. A
 * compile-and-run pass whose output is missing any expected value is the
 * observed live failure class: a wrong median(), printed confidently,
 * sailing through on exit 0.
 */
export function canonicalCallMismatch(request: string, output: string): boolean {
  // Interactive exercises run against harness probe inputs, so a literal
  // call in the prose ("Esempio: media(3, 4) deve dare 3.5") describes an
  // example, not the probe run's output. Only judge non-interactive tasks.
  if (/\b(?:chied\w*|inserisc\w*|inserire|ask(?:s|ing)?\b|\binput\b)/i.test(request)) {
    return false;
  }
  const expected: number[] = [];
  for (const match of request.matchAll(/\b([A-Za-z_]\w*)\(([^()]*)\)/g)) {
    const fn = CANONICAL_FUNCTIONS[match[1].toLowerCase()];
    if (!fn) continue;
    const args = parseLiteralCallArgs(match[2]);
    if (!args) continue;
    const value = fn(args);
    if (value !== null) expected.push(value);
  }
  if (!expected.length) return false;
  if (expected.some((value) => !outputContainsValue(output, value))) return true;

  // The final requested call's result should also be the final numeric value
  // printed. Without this, merely echoing median([3, 1, 4, 1, 5]) passes
  // because the expected median (3) happens to occur among the inputs.
  const numericTokens = output.match(/-?\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?/g) ?? [];
  let tail = numericTokens.at(-1) ?? '';
  if ((tail.match(/[.,]/g) ?? []).length > 1) {
    tail = tail.split(/[.,]/).at(-1) ?? '';
  }
  return !outputContainsValue(tail, expected.at(-1)!);
}

/**
 * "Contatore.java dovrebbe stampare 5 (…) ma stampa 4", "should print 5050"
 * — fix requests often state the one number the corrected program must
 * print. Only the value attached to the should/must-print verb is trusted;
 * the reported wrong value ("ma stampa 4") is ignored.
 */
const STATED_EXPECTED_PRINT =
  /\b(?:should|must)\s+(?:print|output|show|return)|\b(?:dovrebbe|deve)\s+(?:stampare|restituire|mostrare)/i;
const STATED_EXPECTED_VALUE = new RegExp(
  `(?:${STATED_EXPECTED_PRINT.source})\\s+[«"'\`]?(-?\\d+(?:[.,]\\d+)?)`,
  'i',
);

export function statedExpectedOutputMismatch(request: string, output: string): boolean {
  const stated = request.match(STATED_EXPECTED_VALUE)?.[1];
  if (!stated) return false;
  return !outputContainsValue(output, Number(stated.replace(',', '.')));
}
