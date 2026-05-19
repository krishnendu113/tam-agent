// Web search tool - performs web searches via DuckDuckGo HTML endpoint.

const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';

/**
 * Web search tool definition.
 */
export const webSearchTool = {
  name: 'web_search',
  description: 'Perform a web search using DuckDuckGo. Returns top result titles, snippets, and URLs.',
  tags: ['web', 'research'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string'
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (default: 5, max: 10)'
      }
    },
    required: ['query']
  },
  async handler(input) {
    const { query, numResults = 5 } = input;

    try {
      const body = new URLSearchParams({ q: query });

      const response = await fetch(DUCKDUCKGO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; TAMAgent/1.0)'
        },
        body: body.toString()
      });

      if (!response.ok) {
        return { error: `DuckDuckGo request failed (${response.status})` };
      }

      const html = await response.text();
      const results = parseResults(html, Math.min(numResults, 10));

      return { results, total: results.length, query };
    } catch (err) {
      return { error: `Web search failed: ${err.message}` };
    }
  }
};

/**
 * Parses DuckDuckGo HTML search results.
 */
function parseResults(html, maxResults) {
  const results = [];

  // DuckDuckGo HTML results are in <a class="result__a"> for titles/URLs
  // and <a class="result__snippet"> for snippets
  const resultBlocks = html.split(/class="result\s/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= maxResults) break;

    // Extract title and URL from result__a
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    // Extract snippet from result__snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/);

    if (titleMatch) {
      let url = titleMatch[1];
      // DuckDuckGo wraps URLs in a redirect — extract the actual URL
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

export default webSearchTool;
