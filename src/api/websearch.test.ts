import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWebSearchProvider } from './websearch.js';

/** Minimal DuckDuckGo HTML shaped like the real `/html/` response. */
function ddgHtml(
  rows: Array<{ href: string; title: string; snippet: string }>,
): string {
  return rows
    .map(
      (r) =>
        `<div class="result results_links">` +
        `<a rel="nofollow" class="result__a" href="${r.href}">${r.title}</a>` +
        `<a class="result__snippet" href="${r.href}">${r.snippet}</a>` +
        `</div>`,
    )
    .join('\n');
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DuckDuckGo provider', () => {
  it('parses title, url and snippet from result markup', async () => {
    const html = ddgHtml([
      { href: 'https://a.example/one', title: 'First &amp; Best', snippet: 'A <b>bold</b> snippet.' },
      { href: 'https://b.example/two', title: 'Second', snippet: 'Another one.' },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse(html)),
    );
    const provider = resolveWebSearchProvider({ MINERVA_SEARCH_PROVIDER: 'duckduckgo' } as NodeJS.ProcessEnv);
    const results = await provider!.search('anything');

    expect(results).toEqual([
      { title: 'First & Best', url: 'https://a.example/one', snippet: 'A bold snippet.' },
      { title: 'Second', url: 'https://b.example/two', snippet: 'Another one.' },
    ]);
  });

  it('unwraps the /l/?uddg= click-redirect into the real url', async () => {
    const target = 'https://real.example/page?x=1&y=2';
    const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse(ddgHtml([{ href, title: 'Redirected', snippet: 'S.' }]))),
    );
    const provider = resolveWebSearchProvider({} as NodeJS.ProcessEnv);
    const [result] = await provider!.search('q');

    expect(result.url).toBe(target);
  });

  it('honors maxResults', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      href: `https://x.example/${i}`,
      title: `T${i}`,
      snippet: `S${i}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse(ddgHtml(rows))),
    );
    const provider = resolveWebSearchProvider({} as NodeJS.ProcessEnv);
    const results = await provider!.search('q', { maxResults: 3 });

    expect(results).toHaveLength(3);
  });

  it('throws on a non-OK HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textResponse('nope', 429)),
    );
    const provider = resolveWebSearchProvider({} as NodeJS.ProcessEnv);
    await expect(provider!.search('q')).rejects.toThrow(/429/);
  });
});

describe('Tavily provider', () => {
  it('maps content to snippet and posts the api key', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          { title: 'Doc', url: 'https://t.example/doc', content: 'clean extract' },
          { title: 'No url', content: 'dropped' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveWebSearchProvider({
      MINERVA_SEARCH_PROVIDER: 'tavily',
      MINERVA_TAVILY_KEY: 'tvly-123',
    } as unknown as NodeJS.ProcessEnv);
    const results = await provider!.search('q');

    expect(results).toEqual([{ title: 'Doc', url: 'https://t.example/doc', snippet: 'clean extract' }]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ api_key: 'tvly-123', query: 'q' });
  });
});

describe('Brave provider', () => {
  it('reads web.results and sends the subscription token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        web: { results: [{ title: 'B', url: 'https://brave.example/b', description: 'desc' }] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveWebSearchProvider({
      MINERVA_SEARCH_PROVIDER: 'brave',
      MINERVA_BRAVE_KEY: 'brv-9',
    } as unknown as NodeJS.ProcessEnv);
    const results = await provider!.search('q');

    expect(results).toEqual([{ title: 'B', url: 'https://brave.example/b', snippet: 'desc' }]);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('brv-9');
  });
});

describe('resolveWebSearchProvider', () => {
  it('defaults to duckduckgo with no configuration', () => {
    expect(resolveWebSearchProvider({} as NodeJS.ProcessEnv)?.id).toBe('duckduckgo');
  });

  it('returns null when disabled', () => {
    expect(resolveWebSearchProvider({ MINERVA_SEARCH_PROVIDER: 'none' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveWebSearchProvider({ MINERVA_SEARCH_PROVIDER: 'off' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('throws a clear error when a selected backend lacks its key/url', () => {
    expect(() =>
      resolveWebSearchProvider({ MINERVA_SEARCH_PROVIDER: 'tavily' } as NodeJS.ProcessEnv),
    ).toThrow(/MINERVA_TAVILY_KEY/);
    expect(() =>
      resolveWebSearchProvider({ MINERVA_SEARCH_PROVIDER: 'searxng' } as NodeJS.ProcessEnv),
    ).toThrow(/MINERVA_SEARXNG_URL/);
  });

  it('rejects an unknown provider name', () => {
    expect(() =>
      resolveWebSearchProvider({ MINERVA_SEARCH_PROVIDER: 'bing' } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown MINERVA_SEARCH_PROVIDER/);
  });
});
