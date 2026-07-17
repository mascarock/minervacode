import { numbersIn } from './numeric.js';

const NUMERIC_RANGE =
  /\b(?:from|da)\s+(-?\d+)\s+(?:down\s+to|to|a|fino\s+a)\s+(-?\d+)\b/i;

function fizzBuzzLine(n: number): string {
  if (n % 15 === 0) return 'FizzBuzz';
  if (n % 3 === 0) return 'Fizz';
  if (n % 5 === 0) return 'Buzz';
  return String(n);
}

/** FizzBuzz over an explicit numeric range must print every line in order. */
export function fizzBuzzMismatch(request: string, output: string): boolean {
  if (!/\bfizz\s*buzz\b/i.test(request)) return false;
  const match = request.match(NUMERIC_RANGE);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end - start > 100) return false;
  const expected = Array.from({ length: end - start + 1 }, (_, index) =>
    fizzBuzzLine(start + index),
  );
  const actual = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = actual.slice(-expected.length);
  return tail.length !== expected.length || tail.some((value, index) => value !== expected[index]);
}

/** Explicit countdown bounds are small enough to verify exactly. */
export function countdownMismatch(request: string, output: string): boolean {
  const match = request.match(NUMERIC_RANGE);
  if (
    !match ||
    !/\b(?:counts?\s+down|count(?:ing)?\s+down|countdown|conto\s+alla\s+rovescia)\b/i.test(
      request,
    )
  ) {
    return false;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < end || start - end > 100) return false;
  const expected = Array.from({ length: start - end + 1 }, (_, index) => start - index);
  const actual = numbersIn(output).slice(-expected.length);
  return actual.length !== expected.length || actual.some((value, index) => value !== expected[index]);
}
