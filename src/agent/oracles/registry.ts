import {
  countedSortMismatch,
  threeNumberArithmeticMismatch,
  threeNumberMinimumSumMismatch,
} from './arithmetic.js';
import { canonicalCallMismatch, statedExpectedOutputMismatch } from './canonical.js';
import { countdownMismatch, fizzBuzzMismatch } from './range.js';
import {
  degenerateSequenceOutput,
  fibonacciSequenceMismatch,
  primeSequenceMismatch,
} from './sequence.js';
import type { Oracle, OracleVerdict } from './types.js';

const DEGENERATE_GUIDANCE =
  '[verification] The program ran but its output is the same number repeated — a "first N" sequence must have distinct terms. Fix the generator so it advances between terms.';

const SEQUENCE_GUIDANCE =
  '[verification] The program ran, but it did not print the requested sequence in order (all N terms, correct values). Generate the exact requested terms; do not print ordinary counting numbers or stop early.';

const WRONG_OUTPUT_GUIDANCE =
  '[verification] The program ran, but its output did not satisfy the requested result.';

const THREE_NUMBER_GUIDANCE = `${WRONG_OUTPUT_GUIDANCE} The verification inputs are 9, 4, and 2: print their sum (15) and, when requested, the smallest value (2). Your current output is missing at least one of those results.`;

const GENERIC_GUIDANCE = `${WRONG_OUTPUT_GUIDANCE} Read the requested behavior again and produce every required value in the correct order.`;

function oracle(
  name: string,
  mismatch: (request: string, output: string) => boolean,
  guidance: string,
): Oracle {
  return { name, mismatch, guidance: () => guidance };
}

/**
 * Ordered because the first match decides the correction the model sees, and
 * the most specific diagnosis is the most useful one: "your sequence
 * collapsed to one value" beats "your output is wrong". Preserves the
 * precedence of the hand-rolled chain this registry replaced.
 */
export const ORACLES: readonly Oracle[] = [
  oracle('degenerate-sequence', degenerateSequenceOutput, DEGENERATE_GUIDANCE),
  oracle('prime-sequence', primeSequenceMismatch, SEQUENCE_GUIDANCE),
  oracle('fibonacci-sequence', fibonacciSequenceMismatch, SEQUENCE_GUIDANCE),
  oracle(
    'three-number-arithmetic',
    (request, output) =>
      threeNumberArithmeticMismatch(request, output) ||
      threeNumberMinimumSumMismatch(request, output),
    THREE_NUMBER_GUIDANCE,
  ),
  oracle('counted-sort', countedSortMismatch, GENERIC_GUIDANCE),
  oracle('countdown', countdownMismatch, GENERIC_GUIDANCE),
  oracle('fizzbuzz', fizzBuzzMismatch, GENERIC_GUIDANCE),
  oracle('canonical-call', canonicalCallMismatch, GENERIC_GUIDANCE),
  oracle('stated-output', statedExpectedOutputMismatch, GENERIC_GUIDANCE),
];

/**
 * The first oracle that rejects this output, or null when none does. A null
 * verdict is NOT proof of correctness — only that no oracle can prove the
 * output wrong.
 */
export function evaluateOutput(
  request: string,
  output: string,
  oracles: readonly Oracle[] = ORACLES,
): OracleVerdict | null {
  for (const entry of oracles) {
    if (entry.mismatch(request, output)) {
      return { oracle: entry.name, guidance: entry.guidance(request, output) };
    }
  }
  return null;
}
