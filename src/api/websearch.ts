/**
 * Client-side web search. Chat Minerva's Open WebUI has web search disabled
 * server-side (`/api/config` reports `enable_web_search: false`), so the
 * `features.web_search` request flag is silently dropped. Rather than depend
 * on an admin, the agent retrieves results itself and injects them into the
 * prompt — the same shape Open WebUI's own pipeline uses internally.
 *
 * Pluggable by design: DuckDuckGo is the zero-config default (no key, works
 * out of the box), with Tavily / SearXNG / Brave selectable via env var for
 * higher-quality grounding. Selection is read once from the environment.
 */

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  /** One- or two-sentence extract. Kept short on purpose — see the note in
   *  the agent loop about not swamping a 7B's context window. */
  readonly snippet: string;
}

export interface WebSearchOptions {
  readonly signal?: AbortSignal;
  /** Upper bound on results returned; providers may return fewer. */
  readonly maxResults?: number;
  /** Whole-request bound — the search fails if it does not complete in time. */
  readonly timeoutMs?: number;
}

export interface WebSearchProvider {
  /** Stable identity for status lines, e.g. `duckduckgo`. */
  readonly id: string;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (err) {
    if (timeout.signal.aborted && !signal?.aborted) {
      throw new Error(`search request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; last so "&amp;lt;" does not double-decode into "<".
    .replace(/&amp;/g, '&');
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// ── DuckDuckGo (zero-config default) ─────────────────────────────────────────
//
// The keyless HTML endpoint returns organic results as server-rendered markup.
// The official Instant Answer API only returns zero-click answers, not a result
// list, so scraping this endpoint is the standard no-key approach. It can trip
// bot checks under heavy use — that is the cost of requiring no key.

/** Unwrap DuckDuckGo's `/l/?uddg=` click-redirect into the real target URL. */
function resolveDuckDuckGoHref(href: string): string {
  let raw = href;
  if (raw.startsWith('//')) raw = `https:${raw}`;
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const target = url.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    // Not absolute / unparseable — hand back what we were given.
  }
  return raw;
}

function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Each organic result pairs a `result__a` title anchor with the following
  // `result__snippet`. The lazy gap tolerates the markup between them.
  const re =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const url = resolveDuckDuckGoHref(decodeEntities(match[1]));
    const title = stripHtml(match[2]);
    const snippet = stripHtml(match[3]);
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

class DuckDuckGoProvider implements WebSearchProvider {
  readonly id = 'duckduckgo';

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const { signal, maxResults = DEFAULT_MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const res = await fetchWithTimeout(
      'https://html.duckduckgo.com/html/',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': BROWSER_UA,
        },
        body: new URLSearchParams({ q: query }).toString(),
      },
      timeoutMs,
      signal,
    );
    if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
    return parseDuckDuckGoHtml(await res.text()).slice(0, maxResults);
  }
}

// ── Tavily (LLM-optimized, free key) ─────────────────────────────────────────

class TavilyProvider implements WebSearchProvider {
  readonly id = 'tavily';
  constructor(private readonly apiKey: string) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const { signal, maxResults = DEFAULT_MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const res = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: maxResults,
          search_depth: 'basic',
        }),
      },
      timeoutMs,
      signal,
    );
    if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? [])
      .filter((r): r is { title: string; url: string; content?: string } => Boolean(r.url && r.title))
      .slice(0, maxResults)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
}

// ── SearXNG (self-hosted / JSON-enabled instance) ────────────────────────────

class SearxngProvider implements WebSearchProvider {
  readonly id = 'searxng';
  constructor(private readonly baseUrl: string) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const { signal, maxResults = DEFAULT_MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': BROWSER_UA } }, timeoutMs, signal);
    if (!res.ok) {
      const hint = res.status === 403 ? ' (this instance likely disables JSON output — self-host or pick another)' : '';
      throw new Error(`SearXNG returned HTTP ${res.status}${hint}`);
    }
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? [])
      .filter((r): r is { title: string; url: string; content?: string } => Boolean(r.url && r.title))
      .slice(0, maxResults)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
}

// ── Brave Search API (free key, independent index) ───────────────────────────

class BraveProvider implements WebSearchProvider {
  readonly id = 'brave';
  constructor(private readonly apiKey: string) {}

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResult[]> {
    const { signal, maxResults = DEFAULT_MAX_RESULTS, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey } },
      timeoutMs,
      signal,
    );
    if (!res.ok) throw new Error(`Brave returned HTTP ${res.status}`);
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.web?.results ?? [])
      .filter((r): r is { title: string; url: string; description?: string } => Boolean(r.url && r.title))
      .slice(0, maxResults)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? '' }));
  }
}

/**
 * Pick the provider from the environment. `duckduckgo` is the default so
 * `/web` works with no configuration. `none`/`off` disables local search.
 * A backend that needs a key/URL throws a clear error when it is missing —
 * the caller surfaces that as a status line rather than searching silently.
 */
export function resolveWebSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchProvider | null {
  const choice = (env.MINERVA_SEARCH_PROVIDER ?? 'duckduckgo').trim().toLowerCase();
  switch (choice) {
    case '':
    case 'duckduckgo':
    case 'ddg':
      return new DuckDuckGoProvider();
    case 'tavily': {
      const key = env.MINERVA_TAVILY_KEY?.trim();
      if (!key) throw new Error('MINERVA_SEARCH_PROVIDER=tavily but MINERVA_TAVILY_KEY is not set');
      return new TavilyProvider(key);
    }
    case 'searxng':
    case 'searx': {
      const base = env.MINERVA_SEARXNG_URL?.trim();
      if (!base) throw new Error('MINERVA_SEARCH_PROVIDER=searxng but MINERVA_SEARXNG_URL is not set');
      return new SearxngProvider(base);
    }
    case 'brave': {
      const key = env.MINERVA_BRAVE_KEY?.trim();
      if (!key) throw new Error('MINERVA_SEARCH_PROVIDER=brave but MINERVA_BRAVE_KEY is not set');
      return new BraveProvider(key);
    }
    case 'none':
    case 'off':
      return null;
    default:
      throw new Error(`Unknown MINERVA_SEARCH_PROVIDER '${choice}' (use duckduckgo|tavily|searxng|brave|none)`);
  }
}
