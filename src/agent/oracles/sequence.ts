import { numbersIn } from './numeric.js';

/**
 * Requests whose output is an inherently DISTINCT integer sequence — the
 * first N primes or Fibonacci numbers. Deterministic verification cannot
 * judge correctness in general, but for these a collapse to one repeated
 * value is an unambiguous broken-generator signal (observed live: "first
 * 20 primes" emitting twenty 2s, yet passing the compile-and-run gate).
 */
const DISTINCT_SEQUENCE_NOUN = /\b(?:primes?|prime numbers?|numeri primi|fibonacci)\b/i;
const FIRST_PRIME_COUNT = /\b(?:first|primi)\s+(\d+)\s+(?:primes?|prime numbers?|numeri primi)\b/i;
const FIRST_FIB_COUNT =
  /\b(?:first|primi)\s+(\d+)\s+(?:fibonacci\s+numbers?|numbers?\s+of\s+fibonacci|numeri\s+di\s+fibonacci|termini\s+di\s+fibonacci)\b/i;

/**
 * True when a distinct-sequence request produced output dominated by a
 * single repeated number — sound (a correct sequence has distinct terms),
 * and narrowly gated so it never fires on ordinary programs.
 */
export function degenerateSequenceOutput(request: string, output: string): boolean {
  if (!DISTINCT_SEQUENCE_NOUN.test(request) || !/\d/.test(request)) return false;
  const nums = output.match(/-?\d+/g);
  if (!nums || nums.length < 4) return false;
  const counts = new Map<string, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top >= 3 && top / nums.length > 0.5;
}

/** Exact oracle for the common small exercise “print the first N primes”. */
export function primeSequenceMismatch(request: string, output: string): boolean {
  const count = Number(request.match(FIRST_PRIME_COUNT)?.[1]);
  if (!Number.isInteger(count) || count < 1 || count > 50) return false;
  const expected: number[] = [];
  for (let candidate = 2; expected.length < count; candidate++) {
    let prime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    }
    if (prime) expected.push(candidate);
  }
  const actual = numbersIn(output).slice(-count);
  return actual.length !== count || actual.some((value, index) => value !== expected[index]);
}

/** Exact oracle for “print the first N Fibonacci numbers” (0 1 1 2 …). */
export function fibonacciSequenceMismatch(request: string, output: string): boolean {
  const count = Number(request.match(FIRST_FIB_COUNT)?.[1]);
  if (!Number.isInteger(count) || count < 3 || count > 50) return false;
  const expected: number[] = [0, 1];
  while (expected.length < count) {
    expected.push(expected.at(-1)! + expected.at(-2)!);
  }
  const actual = numbersIn(output).slice(-count);
  // Accept a 1 1 2 … start too: whether Fibonacci begins at 0 is contested
  // unless the request pins it ("starting 0 1").
  const shifted = [...expected.slice(1), expected.at(-1)! + expected.at(-2)!];
  const matches = (seq: number[]) =>
    actual.length === count && actual.every((value, index) => value === seq[index]);
  if (matches(expected)) return false;
  // If the student explicitly pins the conventional 0, 1 start, accepting
  // the shifted 1, 1 sequence would contradict the request. With no pinned
  // start, accept either common convention.
  const pinsZeroStart =
    /\b(?:start\w*|begin\w*|inizi\w*|part\w*)\s+(?:(?:at|with|da|con)\s+)?0(?:\s*(?:,|and|e)?\s*1)?\b/i.test(
      request,
    );
  return pinsZeroStart || !matches(shifted);
}
