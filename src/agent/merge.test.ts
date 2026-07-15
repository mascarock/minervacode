import { describe, expect, it } from 'vitest';
import { mergePartialWrite } from './merge.js';

const EXISTING = `import math


def average(numbers):
    """Return the arithmetic mean."""
    return sum(numbers) / (len(numbers) - 1)


def maximum(numbers):
    """Return the largest number."""
    best = numbers[0]
    for n in numbers:
        if n > best:
            best = n
    return best


print(average([1, 2]))
`;

describe('mergePartialWrite', () => {
  it('merges a single-function proposal without deleting the rest', () => {
    const proposed = `def average(numbers):
    """Return the arithmetic mean."""
    return sum(numbers) / len(numbers)
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('return sum(numbers) / len(numbers)');
    expect(merged).not.toContain('len(numbers) - 1');
    expect(merged).toContain('def maximum(numbers):');
    expect(merged).toContain('import math');
    expect(merged).toContain('print(average([1, 2]))');
  });

  it('returns null for a complete-file proposal including module code', () => {
    const proposed = `import math


def average(numbers):
    return 1


def maximum(numbers):
    return 2


print(average([1, 2]))
`;
    expect(mergePartialWrite('calc.py', EXISTING, proposed)).toBeNull();
  });

  it('still merges when all defs are present but module code is missing', () => {
    const proposed = `def average(numbers):
    return 1


def maximum(numbers):
    return 2
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('import math');
    expect(merged).toContain('print(average([1, 2]))');
    expect(merged).toContain('return 1');
    expect(merged).toContain('return 2');
  });

  it('returns null when nothing overlaps with the existing file', () => {
    const proposed = `def minimum(numbers):
    return min(numbers)
`;
    expect(mergePartialWrite('calc.py', EXISTING, proposed)).toBeNull();
  });

  it('appends genuinely new definitions alongside a replaced one', () => {
    const proposed = `def average(numbers):
    return 1


def minimum(numbers):
    return min(numbers)
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('return 1');
    expect(merged).toContain('def maximum(numbers):');
    expect(merged).toContain('def minimum(numbers):');
    expect(merged).toContain('print(average([1, 2]))');
  });

  it('handles async defs and decorators as block anchors', () => {
    const existing = `@app.route('/')
def home():
    return 'old'


async def fetch_data():
    return 1
`;
    const proposed = `async def fetch_data():
    return 2
`;
    const merged = mergePartialWrite('app.py', existing, proposed);
    expect(merged).toContain("@app.route('/')");
    expect(merged).toContain("return 'old'");
    expect(merged).toContain('return 2');
    expect(merged).not.toContain('return 1');
  });

  it('returns null for new files and non-python paths', () => {
    expect(mergePartialWrite('calc.py', '', 'def average():\n    pass\n')).toBeNull();
    expect(mergePartialWrite('app.js', 'function a() {}', 'function a() { return 1; }')).toBeNull();
  });

  it('keeps blank-line spacing between functions', () => {
    const proposed = 'def average(numbers):\n    return 0\n';
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('    return 0\n\n\ndef maximum(numbers):');
  });

  it('hoists new imports the replacement needs, after existing imports', () => {
    const proposed = `import statistics
from typing import List


def average(numbers):
    return statistics.mean(numbers)
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('import math\nimport statistics\nfrom typing import List');
    expect(merged).toContain('return statistics.mean(numbers)');
    expect(merged).toContain('def maximum(numbers):');
  });

  it('does not duplicate imports the file already has', () => {
    const proposed = `import math


def average(numbers):
    return math.fsum(numbers) / len(numbers)
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged?.match(/^import math$/gm)).toHaveLength(1);
  });

  it('never copies non-import module-level code from the proposal', () => {
    const proposed = `import statistics
print("debug!")
CONSTANT = 42


def average(numbers):
    return statistics.mean(numbers)
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('import statistics');
    expect(merged).not.toContain('debug!');
    expect(merged).not.toContain('CONSTANT = 42');
  });
});
