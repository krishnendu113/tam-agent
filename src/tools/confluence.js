// Confluence tool - searches and retrieves Confluence pages via Atlassian Cloud REST API.

const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN;

function getAuthHeader() {
  const credentials = Buffer.from(`${JIRA_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');
  return `Basic ${credentials}`;
}

function checkConfig() {
  if (!CONFLUENCE_BASE_URL || !JIRA_EMAIL || !CONFLUENCE_API_TOKEN) {
    return 'Confluence tool is not configured. Set CONFLUENCE_BASE_URL, JIRA_EMAIL, and CONFLUENCE_API_TOKEN (or JIRA_API_TOKEN) environment variables.';
  }
  return null;
}

// Log warning at module load if not configured
const configWarning = checkConfig();
if (configWarning) {
  console.warn(`[confluence] ${configWarning}`);
}

/**
 * Confluence search tool definition.
 */
export const confluenceTool = {
  name: 'confluence_search',
  description: 'Search for Confluence pages using CQL queries. Returns page title, space, excerpt, and URL.',
  tags: ['confluence', 'research'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'CQL query string or text search query'
      },
      space: {
        type: 'string',
        description: 'Optional Confluence space key to limit search'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)'
      }
    },
    required: ['query']
  },
  async handler(input) {
    const error = checkConfig();
    if (error) return { error };

    const { query, space, maxResults = 10 } = input;

    // Build CQL: if user provides raw CQL use it, otherwise wrap in text search
    let cql = query;
    if (space) {
      cql = `space = "${space}" AND (${cql})`;
    }

    const params = new URLSearchParams({
      cql,
      limit: String(maxResults),
      expand: 'metadata.labels'
    });

    const url = `${CONFLUENCE_BASE_URL}/rest/api/content/search?${params}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': getAuthHeader(),
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const text = await response.text();
        return { error: `Confluence API error (${response.status}): ${text}` };
      }

      const data = await response.json();

      const results = (data.results || []).map(page => ({
        id: page.id,
        title: page.title,
        space: page._expandable?.space ? page._expandable.space.split('/').pop() : '',
        excerpt: page.excerpt || '',
        url: `${CONFLUENCE_BASE_URL}${page._links?.webui || ''}`
      }));

      return { results, total: data.totalSize || results.length, query };
    } catch (err) {
      return { error: `Confluence request failed: ${err.message}` };
    }
  }
};

/**
 * Confluence get page tool definition.
 */
export const confluenceGetPageTool = {
  name: 'confluence_get_page',
  description: 'Fetch a Confluence page by its ID. Returns page title, body content, and metadata.',
  tags: ['confluence', 'research'],
  inputSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Confluence page ID'
      }
    },
    required: ['pageId']
  },
  async handler(input) {
    const error = checkConfig();
    if (error) return { error };

    const { pageId } = input;
    const params = new URLSearchParams({
      expand: 'body.storage,version,space'
    });

    const url = `${CONFLUENCE_BASE_URL}/rest/api/content/${encodeURIComponent(pageId)}?${params}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': getAuthHeader(),
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const text = await response.text();
        return { error: `Confluence API error (${response.status}): ${text}` };
      }

      const page = await response.json();

      // Strip HTML tags for a plain text version
      const htmlBody = page.body?.storage?.value || '';
      const plainText = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      return {
        id: page.id,
        title: page.title,
        space: page.space?.key || '',
        version: page.version?.number || 1,
        body: plainText,
        url: `${CONFLUENCE_BASE_URL}${page._links?.webui || ''}`
      };
    } catch (err) {
      return { error: `Confluence request failed: ${err.message}` };
    }
  }
};

export default confluenceTool;
