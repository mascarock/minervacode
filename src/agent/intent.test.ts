import { describe, expect, it } from 'vitest';
import {
  classifyRequest,
  requestRequiredDefinitions,
  requestRequiredDefinitionsWithConfidence,
  requestedNumberCount,
} from './intent.js';

describe('requestRequiredDefinitionsWithConfidence', () => {
  it('marks an explicit definition cue certain', () => {
    expect(
      requestRequiredDefinitionsWithConfidence('Add a function is_even(n) to utils.py.'),
    ).toEqual([{ name: 'is_even', confidence: 'certain' }]);
  });

  it('marks a cue with a space before the paren certain', () => {
    // Bare call syntax cannot match here, so only the def cue sees it.
    expect(
      requestRequiredDefinitionsWithConfidence('Add a function is_prime (n) to utils.py.'),
    ).toEqual([{ name: 'is_prime', confidence: 'certain' }]);
  });

  it('marks bare call syntax in prose only likely', () => {
    expect(requestRequiredDefinitionsWithConfidence('Print gcd(12, 18) and factorial(5).')).toEqual(
      [
        { name: 'gcd', confidence: 'likely' },
        { name: 'factorial', confidence: 'likely' },
      ],
    );
  });

  it('resolves a name demanded both ways as certain', () => {
    expect(
      requestRequiredDefinitionsWithConfidence(
        'Write a function fib(n) and print fib(10).',
      ),
    ).toEqual([{ name: 'fib', confidence: 'certain' }]);
  });

  it('mixes confidences in request order', () => {
    expect(
      requestRequiredDefinitionsWithConfidence(
        'Print average(2, 4) then add a function is_even(n).',
      ),
    ).toEqual([
      { name: 'average', confidence: 'likely' },
      { name: 'is_even', confidence: 'certain' },
    ]);
  });

  it('keeps the name-only API identical to the confidence-tagged one', () => {
    const prompt = 'Create shapes.py with area_circle(r) and area_square(s).';
    expect(requestRequiredDefinitions(prompt)).toEqual(
      requestRequiredDefinitionsWithConfidence(prompt).map((def) => def.name),
    );
  });
});

describe('classifyRequest', () => {
  it('splits required definitions by confidence', () => {
    const intent = classifyRequest('Add a function is_even(n) and print gcd(12, 18).');
    expect(intent.certainRequiredDefinitions).toEqual(['is_even']);
    expect(intent.likelyRequiredDefinitions).toEqual(['gcd']);
    // Request order: both are spelled with call syntax, is_even first.
    expect(intent.requiredDefinitionNames).toEqual(['is_even', 'gcd']);
  });

  it('resolves the gates a run keys on', () => {
    const intent = classifyRequest('Create primes.c and execute it.');
    expect(intent.expectsChanges).toBe(true);
    expect(intent.allowsNewFile).toBe(true);
    expect(intent.requiresExecution).toBe(true);
    expect(intent.explicitSourcePaths).toEqual(['primes.c']);
  });

  it('does not treat an informational request as a change request', () => {
    const intent = classifyRequest('Explain how recursion works.');
    expect(intent.expectsChanges).toBe(false);
    expect(intent.allowsNewFile).toBe(false);
  });

  it('carries the test-edit gate as a bound predicate', () => {
    expect(classifyRequest('Write tests for calc.py.').allowsTestEdit('test_calc.py')).toBe(true);
    expect(
      classifyRequest('Fix the bug in calc.py so the tests pass.').allowsTestEdit('test_calc.py'),
    ).toBe(false);
  });

  it('reports the interactive probe count the verifier will feed', () => {
    expect(classifyRequest('Chiedi tre numeri e sommali.').requestedNumberCount).toBe(3);
    expect(classifyRequest('Print hello.').requestedNumberCount).toBe(null);
  });

  it('exposes the prompt it judged, so gates cannot disagree', () => {
    const prompt = 'Fix calc.py.';
    expect(classifyRequest(prompt).prompt).toBe(prompt);
  });
});

describe('requestedNumberCount', () => {
  it('rejects counts outside the safe probe range', () => {
    expect(requestedNumberCount('Read 1 numbers.')).toBe(null);
    expect(requestedNumberCount('Read 99 numbers.')).toBe(null);
    expect(requestedNumberCount('Read ten numbers.')).toBe(10);
  });
});
