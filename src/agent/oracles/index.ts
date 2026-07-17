export type { Oracle, OracleVerdict } from './types.js';
export { ORACLES, evaluateOutput } from './registry.js';
export { NUMBER_PROBE_VALUES, THREE_NUMBER_PROBE } from './probe.js';
export { outputContainsValue } from './numeric.js';
export {
  countedSortMismatch,
  threeNumberArithmeticMismatch,
  threeNumberMinimumSumMismatch,
} from './arithmetic.js';
export { canonicalCallMismatch, statedExpectedOutputMismatch } from './canonical.js';
export { countdownMismatch, fizzBuzzMismatch } from './range.js';
export {
  degenerateSequenceOutput,
  fibonacciSequenceMismatch,
  primeSequenceMismatch,
} from './sequence.js';
