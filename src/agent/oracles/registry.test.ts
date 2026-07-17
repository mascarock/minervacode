import { describe, expect, it } from 'vitest';
import { ORACLES, evaluateOutput } from './registry.js';
import type { Oracle } from './types.js';

describe('oracle registry', () => {
  it('returns no verdict when nothing can prove the output wrong', () => {
    expect(evaluateOutput('Print the first 5 primes.', '2 3 5 7 11')).toBe(null);
  });

  it('names the oracle that rejected the output', () => {
    const verdict = evaluateOutput('Print the first 5 primes.', '2 2 2 2 2');
    expect(verdict?.oracle).toBe('degenerate-sequence');
    expect(verdict?.guidance).toContain('same number repeated');
  });

  it('prefers the most specific diagnosis when several oracles fire', () => {
    // A collapsed sequence is also a wrong prime sequence; the degenerate
    // diagnosis is the more useful one and is registered first.
    const request = 'Print the first 5 primes.';
    const collapsed = '2 2 2 2 2';
    expect(ORACLES.find((o) => o.name === 'prime-sequence')?.mismatch(request, collapsed)).toBe(
      true,
    );
    expect(evaluateOutput(request, collapsed)?.oracle).toBe('degenerate-sequence');
  });

  it('catches a wrong prime sequence that is not degenerate', () => {
    const verdict = evaluateOutput('Print the first 5 primes.', '1 2 3 4 5');
    expect(verdict?.oracle).toBe('prime-sequence');
    expect(verdict?.guidance).toContain('requested sequence in order');
  });

  it('catches a wrong Fibonacci sequence', () => {
    expect(evaluateOutput('Print the first 6 fibonacci numbers.', '0 1 2 3 4 5')?.oracle).toBe(
      'fibonacci-sequence',
    );
  });

  it('gives three-number arithmetic its probe-specific guidance', () => {
    const verdict = evaluateOutput('Read three numbers and print their sum.', '9');
    expect(verdict?.oracle).toBe('three-number-arithmetic');
    expect(verdict?.guidance).toContain('9, 4, and 2');
    expect(verdict?.guidance).toContain('sum (15)');
  });

  it('accepts a correct three-number sum of the probe values', () => {
    expect(evaluateOutput('Read three numbers and print their sum.', '15')).toBe(null);
  });

  it('catches the remaining oracles with the generic guidance', () => {
    const cases: [string, string, string][] = [
      ['Read three numbers and sort them.', '9 4 2', 'counted-sort'],
      ['Count down from 5 to 1.', '5 4 3', 'countdown'],
      ['Print fizzbuzz from 1 to 5.', '1\n2\nFizz\n4\n5', 'fizzbuzz'],
      ['Print median([3, 1, 4, 1, 5]).', '99', 'canonical-call'],
      ['The program should print 5050.', '1', 'stated-output'],
    ];
    for (const [request, output, oracle] of cases) {
      const verdict = evaluateOutput(request, output);
      expect(verdict?.oracle, request).toBe(oracle);
      expect(verdict?.guidance, request).toContain('produce every required value');
    }
  });

  it('accepts correct output for each of those', () => {
    expect(evaluateOutput('Read three numbers and sort them.', '2 4 9')).toBe(null);
    expect(evaluateOutput('Count down from 5 to 1.', '5 4 3 2 1')).toBe(null);
    expect(evaluateOutput('Print fizzbuzz from 1 to 5.', '1\n2\nFizz\n4\nBuzz')).toBe(null);
    expect(evaluateOutput('Print median([3, 1, 4, 1, 5]).', 'median is 3')).toBe(null);
    expect(evaluateOutput('The program should print 5050.', '5050')).toBe(null);
  });

  it('every oracle has a unique name', () => {
    expect(new Set(ORACLES.map((o) => o.name)).size).toBe(ORACLES.length);
  });

  it('consults oracles in order and stops at the first match', () => {
    const seen: string[] = [];
    const probe = (name: string, result: boolean): Oracle => ({
      name,
      mismatch: () => {
        seen.push(name);
        return result;
      },
      guidance: () => `${name} guidance`,
    });
    const verdict = evaluateOutput('req', 'out', [
      probe('first', false),
      probe('second', true),
      probe('third', true),
    ]);
    expect(verdict).toEqual({ oracle: 'second', guidance: 'second guidance' });
    expect(seen).toEqual(['first', 'second']);
  });
});
