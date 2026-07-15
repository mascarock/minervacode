import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_CHARS = 8_000;
const MAX_FILES = 2_000;
const MAX_PARSE_BYTES = 256 * 1024;
const METADATA_BATCH_SIZE = 40;
const MAX_SYMBOLS_PER_FILE = 24;
const MAX_IMPORTS_PER_FILE = 12;

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.minervacli',
  '.vscode',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.next',
  '.turbo',
]);

const LOW_VALUE_FILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|.*\.min\.(?:js|css)|.*\.map)$/i;
const TEST_FILE = /(?:^|\/)(?:tests?\/|__tests__\/|test_[^/]+|[^/]+[._](?:test|spec)\.)/i;
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.ts',
  '.tsx',
]);

const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'change',
  'code',
  'create',
  'fix',
  'for',
  'in',
  'il',
  'la',
  'le',
  'modify',
  'of',
  'please',
  'project',
  'the',
  'to',
  'update',
  'with',
]);

interface FileMetadata {
  path: string;
  fingerprint: string;
  size: number;
  symbols: string[];
  imports: string[];
}

interface ProjectCache {
  files: Map<string, FileMetadata>;
}

interface RankedMetadata {
  file: FileMetadata;
  score: number;
  relevance: number;
}

const projectCaches = new Map<string, ProjectCache>();

export interface RepoMapOptions {
  projectDir: string;
  /** Latest user request; used only for deterministic file ranking. */
  query?: string;
  /** Character budget for the rendered map (8,000 by default, about 2k tokens). */
  maxChars?: number;
}

export interface RepoMapResult {
  map: string;
  /** All safe project files, alphabetically sorted. */
  files: string[];
  /** Same files ordered by likely relevance to the request. */
  rankedFiles: string[];
  /** Narrow set whose full contents are safe and useful to inject this turn. */
  contextFiles: string[];
  fileCount: number;
  symbolCount: number;
  cacheHit: boolean;
  truncated: boolean;
}

function normalizeRelative(file: string): string {
  return file.replaceAll(path.sep, '/').replace(/^\.\//, '');
}

/** Files whose contents should never be offered to the model automatically. */
export function isSensitiveProjectFile(file: string): boolean {
  const base = path.posix.basename(normalizeRelative(file)).toLowerCase();
  return (
    /^\.env(?:\.|$)/.test(base) ||
    /^(?:credentials?|secrets?|auth)\.json$/.test(base) ||
    /^(?:id_[a-z0-9_-]+|.*\.(?:pem|key|p12|pfx))$/.test(base)
  );
}

function shouldInclude(file: string): boolean {
  const normalized = normalizeRelative(file);
  if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return false;
  const parts = normalized.split('/');
  if (parts.some((part) => SKIP_DIRS.has(part))) return false;
  return !isSensitiveProjectFile(normalized);
}

async function gitProjectFiles(projectDir: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: projectDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    return String(stdout)
      .split('\0')
      .filter(Boolean)
      .map(normalizeRelative)
      .filter(shouldInclude)
      .slice(0, MAX_FILES)
      .sort();
  } catch {
    return null;
  }
}

async function walkProjectFiles(projectDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    const absolute = path.join(projectDir, relativeDir);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const relative = normalizeRelative(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(relative);
      } else if (entry.isFile() && shouldInclude(relative)) {
        files.push(relative);
      }
      // Never follow symlinks during repository discovery.
    }
  }

  await walk('');
  return files.sort();
}

export async function discoverProjectFiles(projectDir: string): Promise<string[]> {
  const gitFiles = await gitProjectFiles(projectDir);
  return gitFiles?.length ? gitFiles : walkProjectFiles(projectDir);
}

function matches(text: string, pattern: RegExp): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) result.push(value);
  }
  return result;
}

function unique(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

/** Lightweight symbol extraction: deterministic, dependency-free, and intentionally conservative. */
export function extractFileStructure(file: string, text: string): { symbols: string[]; imports: string[] } {
  const ext = path.extname(file).toLowerCase();
  let symbols: string[] = [];
  let imports: string[] = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    symbols = [
      ...matches(text, /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm),
      ...matches(text, /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm),
      ...matches(text, /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm),
      ...matches(text, /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm),
    ];
    imports = [
      ...matches(text, /\bfrom\s+['"]([^'"]+)['"]/g),
      ...matches(text, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...matches(text, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...matches(text, /^\s*import\s+['"]([^'"]+)['"]/gm),
    ];
  } else if (ext === '.py') {
    symbols = [
      ...matches(text, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm),
      ...matches(text, /^\s*class\s+([A-Za-z_]\w*)/gm),
    ];
    imports = [
      ...matches(text, /^\s*from\s+([.A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+import\s+/gm),
      ...matches(text, /^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/gm),
    ];
  } else if (ext === '.go') {
    symbols = [
      ...matches(text, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm),
      ...matches(text, /^\s*type\s+([A-Za-z_]\w*)\s+/gm),
    ];
    imports = matches(text, /^\s*"([^"]+)"\s*$/gm);
  } else if (ext === '.rs') {
    symbols = [
      ...matches(text, /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm),
      ...matches(text, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm),
    ];
    imports = matches(text, /^\s*use\s+([^;]+);/gm);
  } else if (['.java', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(ext)) {
    symbols = [
      ...matches(text, /^\s*(?:public\s+|private\s+|protected\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_]\w*)/gm),
      ...matches(text, /^\s*(?:[A-Za-z_]\w*[\s*&]+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm),
    ];
    imports = matches(text, /^\s*#include\s*[<"]([^>"]+)[>"]/gm);
  }

  return {
    symbols: unique(symbols, MAX_SYMBOLS_PER_FILE),
    imports: unique(imports, MAX_IMPORTS_PER_FILE),
  };
}

async function readMetadata(
  projectDir: string,
  file: string,
  cached: FileMetadata | undefined,
): Promise<{ metadata: FileMetadata; cacheHit: boolean } | null> {
  const absolute = path.join(projectDir, file);
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) return null;
    const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (cached?.fingerprint === fingerprint) return { metadata: cached, cacheHit: true };

    let symbols: string[] = [];
    let imports: string[] = [];
    if (info.size <= MAX_PARSE_BYTES && SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      const text = await readFile(absolute, 'utf8');
      if (!text.includes('\0')) ({ symbols, imports } = extractFileStructure(file, text));
    }
    return {
      metadata: { path: file, fingerprint, size: info.size, symbols, imports },
      cacheHit: false,
    };
  } catch {
    return null;
  }
}

function queryTokens(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return unique(
    tokens.filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token)),
    40,
  );
}

function importTargets(source: FileMetadata, allPaths: Set<string>): string[] {
  const targets: string[] = [];
  const sourceDir = path.posix.dirname(source.path);
  for (const rawImport of source.imports) {
    const normalizedImport = rawImport.replace(/^\.+/, (dots) => '../'.repeat(Math.max(0, dots.length - 1)));
    const imported = rawImport.startsWith('.')
      ? path.posix.normalize(path.posix.join(sourceDir, normalizedImport))
      : rawImport.replaceAll('.', '/');
    // TS projects commonly write `./module.js` while the source file is
    // module.ts (NodeNext). Probe the import as written and without its suffix.
    const base = imported.replace(/\.(?:[cm]?[jt]sx?|py)$/, '');
    const candidates = [
      imported,
      base,
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
      `${base}.py`, `${base}/__init__.py`, `${base}/index.ts`, `${base}/index.js`,
    ];
    const found = candidates.find((candidate) => allPaths.has(candidate));
    if (found) targets.push(found);
  }
  return unique(targets, MAX_IMPORTS_PER_FILE);
}

function rankMetadata(metadata: FileMetadata[], query: string): RankedMetadata[] {
  const tokens = queryTokens(query);
  const paths = new Set(metadata.map((file) => file.path));
  const inbound = new Map<string, number>();
  for (const file of metadata) {
    for (const target of importTargets(file, paths)) {
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }
  const queryMentionsTests = tokens.some((token) => /tests?|spec/.test(token));

  return metadata
    .map((file): RankedMetadata => {
      const lowerPath = file.path.toLowerCase();
      const base = path.posix.basename(lowerPath, path.posix.extname(lowerPath));
      const pathTokens: string[] = lowerPath.match(/[\p{L}\p{N}_-]+/gu) ?? [];
      let structural = Math.log2((inbound.get(file.path) ?? 0) + 1) * 5;
      let relevance = 0;
      if (!file.path.includes('/')) structural += 1;
      if (/^(?:readme|package\.json|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json)/i.test(file.path)) structural += 2;
      if (LOW_VALUE_FILES.test(file.path)) structural -= 20;
      if (TEST_FILE.test(file.path) && !queryMentionsTests) structural -= 2;
      for (const token of tokens) {
        if (base === token) relevance += 30;
        else if (pathTokens.includes(token)) relevance += 14;
        else if (token.length >= 4 && lowerPath.includes(token)) relevance += 8;
        if (file.symbols.some((symbol) => symbol.toLowerCase() === token)) relevance += 24;
        else if (
          token.length >= 4 &&
          file.symbols.some((symbol) => symbol.toLowerCase().includes(token))
        ) relevance += 8;
      }
      return { file, relevance, score: structural + relevance };
    })
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
}

function renderRepoMap(ranked: FileMetadata[], maxChars: number): { map: string; truncated: boolean } {
  const lines = [
    'Repository map (ranked for this request; symbols are declarations, not full file contents):',
  ];
  let truncated = false;
  for (const file of ranked) {
    const next = [file.path];
    if (file.symbols.length) next.push(`  symbols: ${file.symbols.join(', ')}`);
    if (file.imports.length) {
      const imports = [...file.imports].sort(
        (a, b) => Number(!a.startsWith('.')) - Number(!b.startsWith('.')),
      );
      next.push(`  imports: ${imports.slice(0, 6).join(', ')}`);
    }
    const candidate = [...lines, ...next].join('\n');
    if (candidate.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(...next);
  }
  if (truncated) lines.push(`… ${ranked.length - lines.filter((line) => !line.startsWith(' ') && line !== lines[0]).length} lower-ranked files omitted`);
  return { map: lines.join('\n'), truncated };
}

export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
  const projectDir = path.resolve(options.projectDir);
  const files = await discoverProjectFiles(projectDir);
  const cache = projectCaches.get(projectDir) ?? { files: new Map<string, FileMetadata>() };
  const nextCache = new Map<string, FileMetadata>();
  const metadata: FileMetadata[] = [];
  let hits = 0;

  for (let offset = 0; offset < files.length; offset += METADATA_BATCH_SIZE) {
    const batch = files.slice(offset, offset + METADATA_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((file) => readMetadata(projectDir, file, cache.files.get(file))),
    );
    for (const result of results) {
      if (!result) continue;
      metadata.push(result.metadata);
      nextCache.set(result.metadata.path, result.metadata);
      if (result.cacheHit) hits++;
    }
  }
  cache.files = nextCache;
  projectCaches.set(projectDir, cache);

  const ranked = rankMetadata(metadata, options.query ?? '');
  const rankedFiles = ranked.map((entry) => entry.file);
  const maxRelevance = ranked.reduce((max, entry) => Math.max(max, entry.relevance), 0);
  const focused = maxRelevance
    ? ranked
        .filter((entry) => entry.relevance >= Math.max(8, maxRelevance * 0.4))
        .slice(0, 8)
        .map((entry) => entry.file.path)
    : [];
  const contextFiles = focused.length
    ? focused
    : rankedFiles
        .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file.path).toLowerCase()))
        .slice(0, 8)
        .map((file) => file.path);
  const rendered = renderRepoMap(rankedFiles, Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS));
  return {
    ...rendered,
    files: metadata.map((file) => file.path).sort(),
    rankedFiles: rankedFiles.map((file) => file.path),
    contextFiles,
    fileCount: metadata.length,
    symbolCount: metadata.reduce((total, file) => total + file.symbols.length, 0),
    cacheHit: metadata.length === hits,
  };
}

/** Test and project-switch hook; normal callers benefit from process-wide per-file caching. */
export function clearRepoMapCache(projectDir?: string): void {
  if (projectDir) projectCaches.delete(path.resolve(projectDir));
  else projectCaches.clear();
}
