/**
 * Weak models often answer "fix this function" with a code block holding
 * ONLY that function. Applying it as a whole-file Write would silently
 * delete everything else, so partial proposals are merged def-by-def into
 * the existing file instead. The bias is always towards preserving code
 * the proposal does not mention.
 */

const BLOCK_START = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
const DECORATOR = /^@\w/;

interface Block {
  name: string;
  start: number;
  /** Exclusive end line index. */
  end: number;
}

/** Top-level def/class blocks; a block runs until the next column-0 statement. */
function topLevelBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let pendingDecorator = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(BLOCK_START);
    if (match) {
      if (current) current.end = pendingDecorator >= 0 ? pendingDecorator : i;
      const start = pendingDecorator >= 0 ? pendingDecorator : i;
      current = { name: match[1], start, end: lines.length };
      blocks.push(current);
      pendingDecorator = -1;
    } else if (DECORATOR.test(lines[i])) {
      if (pendingDecorator === -1) pendingDecorator = i;
      if (current) {
        current.end = pendingDecorator;
        current = null;
      }
    } else if (/^\S/.test(lines[i])) {
      pendingDecorator = -1;
      if (current) {
        current.end = i;
        current = null;
      }
    } else if (lines[i].trim()) {
      // Indented content interrupts a decorator group.
      if (!current) pendingDecorator = -1;
    }
  }
  return blocks;
}

const IMPORT_LINE = /^(?:import\s+\S|from\s+\S+\s+import\s+\S)/;
const JS_IMPORT_LINE = /^(?:import\s+\S|export\s+.+\s+from\s+['"]|(?:const|let|var)\s+\w+\s*=\s*require\s*\()/;

function jsBlockName(line: string): string | null {
  const declaration = line.match(
    /^(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function|class)\s+([A-Za-z_$][\w$]*)/,
  );
  if (declaration) return declaration[1];
  const callable = line.match(
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/,
  );
  return callable?.[1] ?? null;
}

function braceDelta(line: string): number {
  // This is intentionally structural rather than a JS parser. Removing
  // quoted strings avoids the common false positive from template/object
  // examples while keeping the dependency footprint at zero.
  const structural = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
  return (structural.match(/{/g)?.length ?? 0) - (structural.match(/}/g)?.length ?? 0);
}

/** Top-level JS/TS functions/classes/callable constants, including JSDoc. */
function javaScriptBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = jsBlockName(lines[i]);
    if (!name) continue;

    let start = i;
    if (i > 0 && lines[i - 1].trim().endsWith('*/')) {
      for (let cursor = i - 1; cursor >= 0; cursor--) {
        if (lines[cursor].trim().startsWith('/**')) {
          start = cursor;
          break;
        }
        if (lines[cursor].trim() && !lines[cursor].trim().startsWith('*')) break;
      }
    }

    let depth = 0;
    let sawBrace = false;
    let end = i + 1;
    for (let cursor = i; cursor < lines.length; cursor++) {
      const delta = braceDelta(lines[cursor]);
      if (lines[cursor].includes('{')) sawBrace = true;
      depth += delta;
      end = cursor + 1;
      if (
        (sawBrace && depth <= 0) ||
        (!sawBrace && /;\s*(?:\/\/.*)?$/.test(lines[cursor]))
      ) break;
    }
    blocks.push({ name, start, end });
    i = end - 1;
  }
  return blocks;
}

/**
 * Proposal imports the replacement functions need (e.g. `import math` next
 * to an area() that now uses math.pi). Only import/from lines are carried
 * over — never arbitrary module-level code.
 */
function missingImports(
  oldLines: string[],
  newLines: string[],
  newBlocks: Block[],
  importLine = IMPORT_LINE,
): string[] {
  const inBlock = new Set<number>();
  for (const block of newBlocks) {
    for (let i = block.start; i < block.end; i++) inBlock.add(i);
  }
  const existing = new Set(oldLines.map((l) => l.trim()));
  return newLines.filter(
    (line, i) => !inBlock.has(i) && importLine.test(line.trim()) && !existing.has(line.trim()),
  );
}

/** Line index right after the existing top-level imports (or the shebang). */
function importInsertIndex(lines: string[], importLine = IMPORT_LINE): number {
  let index = 0;
  if (lines[0]?.startsWith('#!')) index = 1;
  for (let i = index; i < lines.length; i++) {
    if (importLine.test(lines[i].trim())) index = i + 1;
    else if (lines[i].trim() && !lines[i].startsWith('#')) break;
  }
  return index;
}

function blockText(lines: string[], block: Block): string {
  // Trim trailing blank lines so spacing is controlled by the merge.
  let end = block.end;
  while (end > block.start && !lines[end - 1].trim()) end--;
  return lines.slice(block.start, end).join('\n');
}

/** Non-empty lines that live outside every block (imports, main code). */
function moduleLevelLines(lines: string[], blocks: Block[]): string[] {
  const inBlock = new Set<number>();
  for (const block of blocks) {
    for (let i = block.start; i < block.end; i++) inBlock.add(i);
  }
  return lines.filter((line, i) => !inBlock.has(i) && line.trim());
}

function preserveJavaScriptExport(oldText: string, replacement: string): string {
  const oldDeclaration = oldText.split('\n').find((line) => jsBlockName(line));
  const modifier = oldDeclaration?.match(/^(export\s+(?:default\s+)?)/)?.[1];
  if (!modifier) return replacement;
  const lines = replacement.split('\n');
  const declaration = lines.findIndex((line) => jsBlockName(line));
  if (declaration < 0 || /^export\s+/.test(lines[declaration])) return replacement;
  lines[declaration] = modifier + lines[declaration];
  return lines.join('\n');
}

function mergeBlocks(
  existing: string,
  proposed: string,
  findBlocks: (lines: string[]) => Block[],
  importLine: RegExp,
  preserveExports = false,
): string | null {
  const oldLines = existing.split('\n');
  const newLines = proposed.split('\n');
  const oldBlocks = findBlocks(oldLines);
  const newBlocks = findBlocks(newLines);
  if (!oldBlocks.length || !newBlocks.length) return null;

  const oldNames = new Set(oldBlocks.map((b) => b.name));
  const newNames = new Set(newBlocks.map((b) => b.name));
  const shared = [...newNames].filter((n) => oldNames.has(n));
  // Nothing overlaps — there is no anchor to merge on.
  if (!shared.length) return null;

  const coversAllDefs = [...oldNames].every((n) => newNames.has(n));
  const newModuleCode = moduleLevelLines(newLines, newBlocks).length > 0;
  const oldModuleCode = moduleLevelLines(oldLines, oldBlocks).length > 0;
  // A real full-file proposal restates every definition AND whatever
  // module-level code the file had. A proposal that has all defs but drops
  // the module-level code is still partial.
  if (coversAllDefs && (newModuleCode || !oldModuleCode)) return null;

  const replacements = new Map(
    newBlocks.filter((b) => oldNames.has(b.name)).map((b) => [b.name, b]),
  );
  const additions = newBlocks
    .filter((b) => !oldNames.has(b.name))
    .map((b) => blockText(newLines, b));

  const hoisted = missingImports(oldLines, newLines, newBlocks, importLine);

  const out: string[] = [];
  let cursor = 0;
  if (hoisted.length) {
    const at = importInsertIndex(oldLines, importLine);
    out.push(...oldLines.slice(0, at), ...hoisted);
    if (oldLines[at]?.trim()) out.push('');
    cursor = at;
  }
  for (const block of oldBlocks) {
    out.push(...oldLines.slice(cursor, block.start));
    let trimmedEnd = block.end;
    while (trimmedEnd > block.start && !oldLines[trimmedEnd - 1].trim()) trimmedEnd--;
    const replacement = replacements.get(block.name);
    if (replacement !== undefined) {
      const replacementText = blockText(newLines, replacement);
      out.push(
        preserveExports
          ? preserveJavaScriptExport(blockText(oldLines, block), replacementText)
          : replacementText,
      );
    } else {
      out.push(...oldLines.slice(block.start, trimmedEnd));
    }
    // Blank lines after the block keep the file's original spacing.
    out.push(...oldLines.slice(trimmedEnd, block.end));
    cursor = block.end;
  }
  out.push(...oldLines.slice(cursor));

  let merged = out.join('\n');
  if (additions.length) {
    merged = `${merged.replace(/\n+$/, '')}\n\n\n${additions.join('\n\n\n')}\n`;
  }
  return merged;
}

/**
 * Returns the existing file with proposed top-level definitions replaced
 * (and unknown ones appended), or null when the proposal is a complete file,
 * a new file, or a language for which structural merging is not supported.
 */
export function mergePartialWrite(
  path: string,
  existing: string,
  proposed: string,
): string | null {
  if (!existing.trim()) return null;
  if (path.endsWith('.py')) {
    return mergeBlocks(existing, proposed, topLevelBlocks, IMPORT_LINE);
  }
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) {
    return mergeBlocks(existing, proposed, javaScriptBlocks, JS_IMPORT_LINE, true);
  }
  return null;
}

/** Definitions an overwrite would delete, used as an autonomous safety gate. */
export function removedTopLevelDefinitions(
  path: string,
  existing: string,
  proposed: string,
): string[] {
  const findBlocks = path.endsWith('.py')
    ? topLevelBlocks
    : /\.(?:[cm]?[jt]sx?)$/.test(path)
      ? javaScriptBlocks
      : null;
  if (!findBlocks) return [];
  const oldNames = new Set(findBlocks(existing.split('\n')).map((block) => block.name));
  const newNames = new Set(findBlocks(proposed.split('\n')).map((block) => block.name));
  return [...oldNames].filter((name) => !newNames.has(name));
}
