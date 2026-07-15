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

/**
 * Proposal imports the replacement functions need (e.g. `import math` next
 * to an area() that now uses math.pi). Only import/from lines are carried
 * over — never arbitrary module-level code.
 */
function missingImports(oldLines: string[], newLines: string[], newBlocks: Block[]): string[] {
  const inBlock = new Set<number>();
  for (const block of newBlocks) {
    for (let i = block.start; i < block.end; i++) inBlock.add(i);
  }
  const existing = new Set(oldLines.map((l) => l.trim()));
  return newLines.filter(
    (line, i) => !inBlock.has(i) && IMPORT_LINE.test(line.trim()) && !existing.has(line.trim()),
  );
}

/** Line index right after the existing top-level imports (or the shebang). */
function importInsertIndex(lines: string[]): number {
  let index = 0;
  if (lines[0]?.startsWith('#!')) index = 1;
  for (let i = index; i < lines.length; i++) {
    if (IMPORT_LINE.test(lines[i].trim())) index = i + 1;
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

/**
 * Returns the existing file with the proposed def/class blocks replaced
 * (and unknown ones appended), or null when the proposal should be applied
 * as a whole file (complete rewrite, new file, or not Python).
 */
export function mergePartialWrite(
  path: string,
  existing: string,
  proposed: string,
): string | null {
  if (!path.endsWith('.py') || !existing.trim()) return null;

  const oldLines = existing.split('\n');
  const newLines = proposed.split('\n');
  const oldBlocks = topLevelBlocks(oldLines);
  const newBlocks = topLevelBlocks(newLines);
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
    newBlocks.filter((b) => oldNames.has(b.name)).map((b) => [b.name, blockText(newLines, b)]),
  );
  const additions = newBlocks
    .filter((b) => !oldNames.has(b.name))
    .map((b) => blockText(newLines, b));

  const hoisted = missingImports(oldLines, newLines, newBlocks);

  const out: string[] = [];
  let cursor = 0;
  if (hoisted.length) {
    const at = importInsertIndex(oldLines);
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
      out.push(replacement);
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
