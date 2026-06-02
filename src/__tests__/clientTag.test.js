import { describe, it, expect } from 'vitest';
import { extractClientTag } from '../clientTag.js';

describe('extractClientTag', () => {
  it('extracts project key from a simple Jira ticket reference', () => {
    expect(extractClientTag('PROJ-123')).toBe('PROJ');
  });

  it('extracts project key from ticket embedded in a sentence', () => {
    expect(extractClientTag('Please look at CAP-4567 for details')).toBe('CAP');
  });

  it('extracts the first match when multiple tickets are present', () => {
    expect(extractClientTag('Check ALPHA-1 and BETA-99')).toBe('ALPHA');
  });

  it('handles project keys with digits (e.g., ABC2-100)', () => {
    expect(extractClientTag('Working on ABC2-100')).toBe('ABC2');
  });

  it('returns null for strings with no Jira ticket pattern', () => {
    expect(extractClientTag('Hello world')).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(extractClientTag('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(extractClientTag(null)).toBeNull();
    expect(extractClientTag(undefined)).toBeNull();
    expect(extractClientTag(123)).toBeNull();
  });

  it('does not match lowercase ticket patterns', () => {
    expect(extractClientTag('proj-123')).toBeNull();
  });

  it('matches valid ticket within text starting with a digit', () => {
    // "1ABC-123" contains "ABC-123" which is a valid ticket match
    expect(extractClientTag('1ABC-123')).toBe('ABC');
  });

  it('handles single-letter project keys (minimum 2 chars required)', () => {
    // Pattern requires [A-Z][A-Z0-9]+, so minimum 2 uppercase/digit chars before dash
    expect(extractClientTag('A-123')).toBeNull();
  });

  it('extracts from text with special characters around the ticket', () => {
    expect(extractClientTag('(TEAM-42) is the issue')).toBe('TEAM');
  });

  it('handles very long project keys', () => {
    expect(extractClientTag('LONGPROJECTKEY-99999')).toBe('LONGPROJECTKEY');
  });
});
