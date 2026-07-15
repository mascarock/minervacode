import { describe, expect, it } from 'vitest';
import {
  mergePartialWrite,
  protectedDefinitionNames,
  removedTopLevelDefinitions,
} from './merge.js';

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

  it('appends a definitions-only proposal that overlaps nothing', () => {
    const proposed = `def minimum(numbers):
    return min(numbers)
`;
    const merged = mergePartialWrite('calc.py', EXISTING, proposed);
    expect(merged).toContain('def minimum');
    expect(merged).toContain('def average');
    expect(merged).toContain('def maximum');
    expect(merged).toContain('print(average([1, 2]))');
  });

  it('keeps the existing body of protected definitions and appends the new one', () => {
    const existing = 'def double(n):\n    return n * 2\n';
    const proposed =
      'def double(n):\n    return n % 2 == 0\n\n\ndef is_even(n):\n    return n % 2 == 0\n';
    const merged = mergePartialWrite(
      'utils.py',
      existing,
      proposed,
      new Set(['double']),
    );
    expect(merged).toContain('return n * 2');
    expect(merged).not.toContain('def double(n):\n    return n % 2 == 0');
    expect(merged).toContain('def is_even');
  });

  it('adopts a new module-level program that still calls the omitted defs', () => {
    const existing = `def is_prime(n):
    if n < 2:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True

count = 0
num = 2
while count < 10:
    if is_prime(num):
        print(num)
        count += 1
    num += 1
`;
    const proposed = `count = 0
num = 2
while count < 40:
    if is_prime(num):
        print(num)
        count += 1
    num += 1
`;
    const merged = mergePartialWrite('main.py', existing, proposed);
    expect(merged).toContain('def is_prime');
    expect(merged).toContain('count < 40');
    expect(merged).not.toContain('count < 10');
  });

  it('adopts the new program body when it anchors on a shared def', () => {
    const existing =
      'def is_prime(n):\n    return n > 1\n\nfor n in range(10):\n    print(n)\n';
    const proposed =
      'import math\n\ndef is_prime(n):\n    return all(n % i for i in range(2, int(math.sqrt(n)) + 1)) and n > 1\n\nfor n in range(40):\n    if is_prime(n):\n        print(n)\n';
    const merged = mergePartialWrite('main.py', existing, proposed);
    expect(merged).toContain('import math');
    expect(merged).toContain('math.sqrt');
    expect(merged).toContain('range(40)');
    expect(merged).not.toContain('for n in range(10)');
  });

  it('still returns null when a non-overlapping proposal has loose statements', () => {
    const proposed = `def minimum(numbers):
    return min(numbers)

print(minimum([3, 1]))
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

  it('returns null for new files and unsupported paths', () => {
    expect(mergePartialWrite('calc.py', '', 'def average():\n    pass\n')).toBeNull();
    expect(mergePartialWrite('notes.md', '# old', '# new')).toBeNull();
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

describe('protectedDefinitionNames', () => {
  it('protects definitions the request never mentions', () => {
    const existing = 'def double(n):\n    return n * 2\n\ndef half(n):\n    return n / 2\n';
    expect(
      protectedDefinitionNames('utils.py', existing, 'Add a function is_even(n) to utils.py.'),
    ).toEqual(new Set(['double', 'half']));
    expect(
      protectedDefinitionNames('utils.py', existing, 'Fix double(n) and add is_even(n).'),
    ).toEqual(new Set(['half']));
  });
});

describe('mergePartialWrite for JavaScript and TypeScript', () => {
  const existing = `import { clamp } from './numbers.js';

export function add(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}
`;

  it('merges one proposed function without deleting another export', () => {
    const proposed = `export function add(a, b) {
  return a + b;
}
`;
    const merged = mergePartialWrite('src/calc.js', existing, proposed);
    expect(merged).toContain('return a + b');
    expect(merged).toContain('export function multiply');
    expect(merged).toContain("import { clamp } from './numbers.js'");
  });

  it('preserves unrelated functions when the proposal includes JSDoc', () => {
    const proposed = `/** Add two numbers. */
export function add(a, b) {
  return a + b;
}
`;
    const merged = mergePartialWrite('src/calc.ts', existing, proposed);
    expect(merged).toContain('/** Add two numbers. */');
    expect(merged).toContain('export function multiply');
  });

  it('preserves an existing named export when the weak proposal drops the modifier', () => {
    const proposed = `function add(a, b) {
  return a + b;
}
`;
    const merged = mergePartialWrite('src/calc.js', existing, proposed);
    expect(merged).toContain('export function add');
    expect(merged).toContain('export function multiply');
  });

  it('handles arrow-function declarations as merge anchors', () => {
    const oldArrow = 'export const add = (a, b) => a - b;\n\nexport const multiply = (a, b) => a * b;\n';
    const proposed = 'export const add = (a, b) => a + b;\n';
    const merged = mergePartialWrite('calc.ts', oldArrow, proposed);
    expect(merged).toContain('add = (a, b) => a + b');
    expect(merged).toContain('multiply = (a, b) => a * b');
  });

  it('treats inline-comment arrow declarations as separate blocks', () => {
    const proposed =
      'export const add = (a, b) => a + b; // fixed\n' +
      'export const multiply = (a, b) => a * b; // preserved\n';
    const merged = mergePartialWrite('calc.js', existing, proposed);
    expect(merged).toContain('export const add');
    expect(merged).toContain('export const multiply');
    expect(merged).not.toContain('export function multiply');
  });

  it('hoists imports required by a partial replacement', () => {
    const proposed = `import { sum } from './sum.js';

export function add(a, b) {
  return sum(a, b);
}
`;
    const merged = mergePartialWrite('calc.js', existing, proposed);
    expect(merged).toContain("import { sum } from './sum.js';");
    expect(merged).toContain('export function multiply');
  });

  it('reports definitions that an unrelated overwrite would delete', () => {
    expect(
      removedTopLevelDefinitions('calc.js', existing, "import { multiply } from './lib.js';\n"),
    ).toEqual(['add', 'multiply']);
    expect(
      removedTopLevelDefinitions(
        'calc.js',
        existing,
        'export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n',
      ),
    ).toEqual([]);
  });

  it('returns null for a complete proposal that restates every function', () => {
    const proposed = `import { clamp } from './numbers.js';

export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}
`;
    expect(mergePartialWrite('calc.js', existing, proposed)).toBeNull();
  });
});
