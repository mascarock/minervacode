import { requestedNumberCount } from '../intent.js';
import { numbersIn } from './numeric.js';
import { NUMBER_PROBE_VALUES, THREE_NUMBER_PROBE } from './probe.js';

const THREE_NUMBER_REQUEST = /\b(?:three|3|tre)\s+(?:numbers?|integers?|numeri)\b/i;
const MINIMUM_REQUEST = /\b(?:min(?:imum)?|smallest|pi[uù]\s+piccol\w*|minim\w*)\b/i;
const SUM_REQUEST = /\b(?:sum|add|total|somm\w*)\b/i;

function requestsThreeNumberMinimumAndSum(request: string): boolean {
  return (
    THREE_NUMBER_REQUEST.test(request) &&
    MINIMUM_REQUEST.test(request) &&
    SUM_REQUEST.test(request)
  );
}

function requestsThreeNumberSum(request: string): boolean {
  return THREE_NUMBER_REQUEST.test(request) && SUM_REQUEST.test(request);
}

/** Numbers printed anywhere in the output, decimal comma tolerated. */
function printedValues(output: string): number[] {
  return (output.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((token) =>
    Number(token.replace(',', '.')),
  );
}

/**
 * True when the narrowly recognised "three numbers + minimum + sum" task
 * did not report both deterministic results for the probe 9, 4, 2. This is
 * the live t03 failure class: a program consumed one value and printed that
 * value as the minimum, while exit 0 and non-empty output looked healthy.
 */
export function threeNumberMinimumSumMismatch(request: string, output: string): boolean {
  if (!requestsThreeNumberMinimumAndSum(request)) return false;
  const values = printedValues(output);
  const expectedMinimum = Math.min(...THREE_NUMBER_PROBE);
  const expectedSum = THREE_NUMBER_PROBE.reduce((total, value) => total + value, 0);
  return !values.includes(expectedMinimum) || !values.includes(expectedSum);
}

/**
 * Reject a runnable three-number arithmetic exercise that printed neither
 * the requested sum nor, when asked, the requested minimum for 9, 4, 2.
 * Exit status alone cannot catch a program that reads only one value.
 */
export function threeNumberArithmeticMismatch(request: string, output: string): boolean {
  if (!requestsThreeNumberSum(request)) return false;
  const values = printedValues(output);
  const expectedSum = THREE_NUMBER_PROBE.reduce((total, value) => total + value, 0);
  if (!values.includes(expectedSum)) return true;
  return requestsThreeNumberMinimumAndSum(request) && !values.includes(Math.min(...THREE_NUMBER_PROBE));
}

/** A counted ascending-sort task must print the probe values in ascending order. */
export function countedSortMismatch(request: string, output: string): boolean {
  const count = requestedNumberCount(request);
  if (!count || !/\b(?:sort\w*|ordin\w*)\b/i.test(request)) return false;
  const actual = numbersIn(output).slice(-count);
  const expected = [...NUMBER_PROBE_VALUES.slice(0, count)].sort((a, b) => a - b);
  return actual.length !== count || actual.some((value, index) => value !== expected[index]);
}
