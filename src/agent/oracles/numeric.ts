/**
 * Does the output print `value` somewhere, at the precision the program
 * chose? "6.7" and "7" both count for 20/3 (rounded to their own decimals);
 * "4.0" never counts for 3. Ambiguous comma tokens are tried as decimal
 * ("4,5" → 4.5), thousands grouping ("1,234" → 1234), and separate list
 * items ("3,1,4" → 3 and 1 and 4).
 */
export function outputContainsValue(output: string, value: number): boolean {
  for (const token of output.match(/-?\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?/g) ?? []) {
    // Scientific notation (Java double formatting): compare relatively.
    if (/[eE]/.test(token)) {
      const printed = Number(token.replace(',', '.'));
      if (Number.isFinite(printed) && Math.abs(printed - value) <= Math.abs(value) * 1e-6) {
        return true;
      }
      continue;
    }
    const candidates: { printed: number; decimals: number }[] = [];
    const parts = token.split(/[.,]/);
    if (parts.length <= 2) {
      candidates.push({
        printed: Number(token.replace(',', '.')),
        decimals: parts[1]?.length ?? 0,
      });
    }
    if (token.includes(',')) {
      candidates.push({ printed: Number(token.replace(/,/g, '')), decimals: 0 });
      for (const part of token.split(',')) {
        if (/^-?\d+$/.test(part)) candidates.push({ printed: Number(part), decimals: 0 });
      }
    }
    for (const { printed, decimals } of candidates) {
      // Strict: an exact half-step off ("5" for 4.5) is not a rounding of it.
      if (Math.abs(printed - value) < 0.5 * 10 ** -decimals) return true;
    }
  }
  return false;
}

/** Every integer token in `output`, in order. */
export function numbersIn(output: string): number[] {
  return (output.match(/-?\d+/g) ?? []).map(Number);
}
