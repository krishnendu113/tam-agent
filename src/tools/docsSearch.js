// Docs search tool - searches Capillary documentation using sitemap + DuckDuckGo site: search.

const WEB_SEARCH_SITEMAP_URL = process.env.WEB_SEARCH_SITEMAP_URL;
const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';

// Cache parsed sitemap URLs
let sitemapUrls = null;
let sitemapLastFetched = 0;
const SITEMAP_CACHE_TTL = 3600000; // 1 hour

/**
 * Fetches and parses the sitemap XML to extract documentation URLs.
 */
async function fetchSitemapUrls() {
  const now = Date.now();
  if (sitemapUrls && (now - sitemapLastFetched) < SITEMAP_CACHE_TTL) {
    return sitemapUrls;
  }

  if (!WEB_SEARCH_SITEMAP_URL) {
    return [];
  }

  try {
    const response = await fetch(WEB_SEARCH_SITEMAP_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TAMAgent/1.0)' }
    });

    if (!response.ok) {
      console.warn(`[docsSearch] Failed to fetch sitemap (${response.status})`);
      return sitemapUrls || [];
    }

    const xml = await response.text();
    // Extract <loc> URLs from sitemap XML
    const urls = [];
    const locRegex = /<loc>(.*?)<\/loc>/g;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      urls.push(match[1]);
    }

    sitemapUrls = urls;
    sitemapLastFetched = now;
    return urls;
  } catch (err) {
    console.warn(`[docsSearch] Sitemap fetch error: ${err.message}`);
    return sitemapUrls || [];
  }
}

/**
 * Extracts the site domain from the sitemap URL for site:-scoped searches.
 */
function getSiteDomain() {
  if (!WEB_SEARCH_SITEMAP_URL) return null;
  try {
    const url = new URL(WEB_SEARCH_SITEMAP_URL);
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Docs search tool definition.
 * Searches Capillary documentation using DuckDuckGo with site: restriction.
 */
export const docsSearchTool = {
  name: 'docs_search',
  description: 'Search Capillary technical documentation (docs.capillarytech.com). Returns relevant doc pages with titles, URLs, and snippets.',
  tags: ['docs', 'research', 'web'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for documentation'
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (default: 5)'
      }
    },
    required: ['query']
  },
  async handler(input) {
    const { query, numResults = 5 } = input;
    const siteDomain = getSiteDomain();

    if (!siteDomain) {
      return { error: 'Docs search not configured. Set WEB_SEARCH_SITEMAP_URL environment variable.' };
    }

    try {
      // Use DuckDuckGo with site: restriction to search only the docs domain
      const siteQuery = `site:${siteDomain} ${query}`;
      const body = new URLSearchParams({ q: siteQuery });

      const response = await fetch(DUCKDUCKGO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; TAMAgent/1.0)'
        },
        body: body.toString()
      });

      if (!response.ok) {
        return { error: `Docs search request failed (${response.status})` };
      }

      const html = await response.text();
      const results = parseResults(html, Math.min(numResults, 10));

      // If DuckDuckGo returns no results, fall back to sitemap keyword matching
      if (results.length === 0) {
        const sitemapResults = await searchSitemap(query, numResults);
        return { results: sitemapResults, total: sitemapResults.length, query, source: 'sitemap' };
      }

      return { results, total: results.length, query, source: 'duckduckgo' };
    } catch (err) {
      // Fall back to sitemap search on any error
      try {
        const sitemapResults = await searchSitemap(query, numResults);
        return { results: sitemapResults, total: sitemapResults.length, query, source: 'sitemap-fallback' };
      } catch {
        return { error: `Docs search failed: ${err.message}` };
      }
    }
  }
};

/**
 * Searches sitemap URLs by keyword matching on the URL path.
 */
async function searchSitemap(query, maxResults) {
  const urls = await fetchSitemapUrls();
  const keywords = query.toLowerCase().split(/\s+/);

  const scored = urls
    .map(url => {
      const path = url.toLowerCase();
      const score = keywords.reduce((s, kw) => s + (path.includes(kw) ? 1 : 0), 0);
      return { url, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return scored.map(item => ({
    title: extractTitleFromUrl(item.url),
    url: item.url,
    snippet: `Documentation page matching: ${keywords.filter(kw => item.url.toLowerCase().includes(kw)).join(', ')}`
  }));
}

/**
 * Extracts a readable title from a documentation URL path.
 */
function extractTitleFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    return last
      .replace(/[-_]/g, ' ')
      .replace(/\.\w+$/, '')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return url;
  }
}

/**
 * Parses DuckDuckGo HTML search results.
 */
function parseResults(html, maxResults) {
  const results = [];
  const resultBlocks = html.split(/class="result\s/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= maxResults) break;

    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/);

    if (titleMatch) {
      let url = titleMatch[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
        : '';

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }
  }

  return results;
}

export default docsSearchTool;
