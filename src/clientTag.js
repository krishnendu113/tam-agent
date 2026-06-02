/**
 * Client Tag Extraction Utility
 *
 * Extracts Jira project keys from query text for per-client cost attribution.
 * The project key is the alphabetic prefix of a Jira ticket reference (e.g., "PROJ" from "PROJ-123").
 */

const JIRA_TICKET_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

/**
 * Extract the Jira project key from a query string.
 *
 * Matches the first Jira ticket reference in the text (pattern: [A-Z][A-Z0-9]+-\d+)
 * and returns the project key portion (everything before the dash and number).
 *
 * @param {string} text - The query text to search for a Jira ticket reference
 * @returns {string|null} The project key (e.g., "PROJ") or null if no match found
 */
export function extractClientTag(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const match = text.match(JIRA_TICKET_PATTERN);
  if (!match) {
    return null;
  }

  // Extract the project key portion (before the dash and digits)
  const ticket = match[0];
  const dashIndex = ticket.lastIndexOf('-');
  return ticket.substring(0, dashIndex);
}
