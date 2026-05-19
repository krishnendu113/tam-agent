// Jira tool - searches and retrieves Jira issues via Atlassian Cloud REST API.

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

function getAuthHeader() {
  const credentials = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${credentials}`;
}

function checkConfig() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return 'Jira tool is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables.';
  }
  return null;
}

// Log warning at module load if not configured
const configWarning = checkConfig();
if (configWarning) {
  console.warn(`[jira] ${configWarning}`);
}

/**
 * Jira search tool definition.
 */
export const jiraTool = {
  name: 'jira_search',
  description: 'Search for Jira issues using JQL queries. Returns issue key, summary, status, assignee, and description.',
  tags: ['jira', 'research'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'JQL query string to search for issues'
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

    const { query, maxResults = 10 } = input;

    const params = new URLSearchParams({
      jql: query,
      maxResults: String(maxResults),
      fields: 'summary,status,assignee,description'
    });

    const url = `${JIRA_BASE_URL}/rest/api/3/search?${params}`;

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
        return { error: `Jira API error (${response.status}): ${text}` };
      }

      const data = await response.json();

      const results = (data.issues || []).map(issue => {
        const desc = issue.fields.description
          ? extractTextFromADF(issue.fields.description)
          : '';
        return {
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name || 'Unknown',
          assignee: issue.fields.assignee?.displayName || 'Unassigned',
          description: desc.length > 200 ? desc.slice(0, 200) + '...' : desc
        };
      });

      return { results, total: data.total, query };
    } catch (err) {
      return { error: `Jira request failed: ${err.message}` };
    }
  }
};

/**
 * Jira get issue tool definition.
 */
export const jiraGetIssueTool = {
  name: 'jira_get_issue',
  description: 'Fetch a single Jira issue by its key (e.g., PROJ-123). Returns full issue details.',
  tags: ['jira', 'research'],
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Jira issue key (e.g., PROJ-123)'
      }
    },
    required: ['key']
  },
  async handler(input) {
    const error = checkConfig();
    if (error) return { error };

    const { key } = input;
    const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(key)}`;

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
        return { error: `Jira API error (${response.status}): ${text}` };
      }

      const issue = await response.json();
      const desc = issue.fields.description
        ? extractTextFromADF(issue.fields.description)
        : '';

      return {
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name || 'Unknown',
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        priority: issue.fields.priority?.name || 'None',
        created: issue.fields.created,
        updated: issue.fields.updated,
        description: desc,
        labels: issue.fields.labels || [],
        url: `${JIRA_BASE_URL}/browse/${issue.key}`
      };
    } catch (err) {
      return { error: `Jira request failed: ${err.message}` };
    }
  }
};

/**
 * Extracts plain text from Atlassian Document Format (ADF).
 */
function extractTextFromADF(adf) {
  if (!adf || typeof adf === 'string') return adf || '';
  if (adf.type === 'text') return adf.text || '';
  if (Array.isArray(adf.content)) {
    return adf.content.map(extractTextFromADF).join('');
  }
  return '';
}

export default jiraTool;
