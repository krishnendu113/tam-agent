/**
 * Property-based tests for DocumentDB URI construction
 *
 * Property 16: DocumentDB URI Construction
 *
 * For any valid combination of endpoint, username, password (with special chars),
 * constructed URI SHALL follow the format
 * `mongodb://{encodedUser}:{encodedPass}@{endpoint}:27017/?tls=true&tlsCAFile={caPath}&retryWrites=false&directConnection=true`
 * with username and password correctly URI-encoded.
 *
 * **Validates: Requirements 9.3, 9.4**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';

describe('Feature: skill-system-enhancement, Property 16: DocumentDB URI Construction', () => {
  let buildDocumentDbUri;

  beforeEach(async () => {
    vi.resetModules();
    // Clear any DOCDB_URI so we test the composed path
    delete process.env.DOCDB_URI;
    delete process.env.DOCDB_CLUSTER_ENDPOINT;
    delete process.env.DOCDB_USERNAME;
    delete process.env.DOCDB_PASSWORD;

    const mod = await import('../db.js');
    buildDocumentDbUri = mod.buildDocumentDbUri;
  });

  afterEach(() => {
    delete process.env.DOCDB_URI;
    delete process.env.DOCDB_CLUSTER_ENDPOINT;
    delete process.env.DOCDB_USERNAME;
    delete process.env.DOCDB_PASSWORD;
    vi.restoreAllMocks();
  });

  // --- Generators ---

  /**
   * Generates valid hostname-like endpoint strings.
   * DocumentDB endpoints look like: my-cluster.cluster-xyz.us-east-1.docdb.amazonaws.com
   */
  function arbEndpoint() {
    return fc.oneof(
      fc.stringMatching(/^[a-z][a-z0-9\-]{2,20}\.[a-z0-9\-]{3,15}\.[a-z]{2,5}\-[a-z]{2,5}\-[0-9]\.[a-z]+\.[a-z]+\.[a-z]+$/),
      fc.stringMatching(/^[a-z][a-z0-9\-]{2,30}\.docdb\.amazonaws\.com$/),
      fc.stringMatching(/^[a-z][a-z0-9]{1,15}$/),
      fc.constant('my-cluster.cluster-abc123.us-east-1.docdb.amazonaws.com'),
      fc.constant('prod-db.cluster-xyz789.eu-west-1.docdb.amazonaws.com'),
      fc.constant('localhost')
    );
  }

  /**
   * Generates usernames that may contain special characters requiring URI encoding.
   */
  function arbUsername() {
    return fc.oneof(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{2,15}$/),
      fc.constant('admin'),
      fc.constant('db_user'),
      fc.constant('user@domain'),
      fc.constant('user:name'),
      fc.constant('user/slash'),
      fc.constant('user#hash'),
      fc.constant('user?query'),
      fc.constant('special!@#$%^&*()'),
      // Generate arbitrary non-empty strings with special chars
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0)
    );
  }

  /**
   * Generates passwords with special characters requiring URI encoding.
   * These are the chars specifically called out in the task: @, :, /, #, ?, etc.
   */
  function arbPassword() {
    return fc.oneof(
      fc.constant('simplepass'),
      fc.constant('p@ss:w/rd#123?x'),
      fc.constant('P@$$w0rd!'),
      fc.constant('pass/with/slashes'),
      fc.constant('pass#with#hashes'),
      fc.constant('pass?with?questions'),
      fc.constant('pass:with:colons'),
      fc.constant('pass@with@ats'),
      fc.constant('c0mpl3x!@#$%^&*()_+-=[]{}|;:,.<>?'),
      fc.constant('spaces in password'),
      fc.constant('über-sëcret-pàss'),
      // Generate arbitrary non-empty strings with diverse characters
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0)
    );
  }

  /**
   * Generates a CA file path for TLS-enabled connections.
   */
  function arbCaPath() {
    return fc.oneof(
      fc.constant('/app/global-bundle.pem'),
      fc.constant('/usr/local/share/ca-certificates/rds-combined-ca-bundle.pem'),
      fc.constant('./global-bundle.pem'),
      fc.constant('/home/user/certs/docdb-cert.pem'),
      fc.stringMatching(/^\/[a-z]{1,10}(\/[a-z]{1,10}){1,3}\.pem$/)
    );
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * For any valid combination of endpoint, username, and password with TLS enabled,
   * the constructed URI SHALL follow the format:
   * mongodb://{encodedUser}:{encodedPass}@{endpoint}:27017/?tls=true&tlsCAFile={caPath}&retryWrites=false&directConnection=true
   */
  it('constructs correct URI format with TLS enabled (caPath provided)', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        arbCaPath(),
        (endpoint, username, password, caPath) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(caPath);

          const expectedUser = encodeURIComponent(username);
          const expectedPass = encodeURIComponent(password);
          const expectedUri = `mongodb://${expectedUser}:${expectedPass}@${endpoint}:27017/?tls=true&tlsCAFile=${caPath}&retryWrites=false&directConnection=true`;

          expect(uri).toBe(expectedUri);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * For any valid combination of endpoint, username, and password with TLS disabled,
   * the constructed URI SHALL follow the format:
   * mongodb://{encodedUser}:{encodedPass}@{endpoint}:27017/?retryWrites=false&directConnection=true
   */
  it('constructs correct URI format with TLS disabled (caPath is null)', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        (endpoint, username, password) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(null);

          const expectedUser = encodeURIComponent(username);
          const expectedPass = encodeURIComponent(password);
          const expectedUri = `mongodb://${expectedUser}:${expectedPass}@${endpoint}:27017/?retryWrites=false&directConnection=true`;

          expect(uri).toBe(expectedUri);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * Username and password SHALL be correctly URI-encoded in the constructed URI.
   * Special characters (@, :, /, #, ?) MUST be percent-encoded.
   */
  it('URI-encodes special characters in username and password', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        arbCaPath(),
        (endpoint, username, password, caPath) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(caPath);

          // Extract credentials from the URI by parsing the mongodb:// prefix
          const withoutPrefix = uri.replace('mongodb://', '');
          const atIdx = withoutPrefix.indexOf('@' + endpoint);
          const credentialsPart = withoutPrefix.substring(0, atIdx);
          const colonIdx = credentialsPart.indexOf(':');
          const extractedUser = credentialsPart.substring(0, colonIdx);
          const extractedPass = credentialsPart.substring(colonIdx + 1);

          // Decoded credentials should match the original values
          expect(decodeURIComponent(extractedUser)).toBe(username);
          expect(decodeURIComponent(extractedPass)).toBe(password);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * The constructed URI SHALL always start with the `mongodb://` scheme prefix.
   */
  it('constructed URI always starts with mongodb:// prefix', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        fc.oneof(arbCaPath(), fc.constant(null)),
        (endpoint, username, password, caPath) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(caPath);

          expect(uri.startsWith('mongodb://')).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * The constructed URI SHALL always contain the endpoint followed by :27017.
   */
  it('constructed URI always contains endpoint:27017', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        fc.oneof(arbCaPath(), fc.constant(null)),
        (endpoint, username, password, caPath) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(caPath);

          expect(uri).toContain(`@${endpoint}:27017/`);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * The constructed URI SHALL always include retryWrites=false and directConnection=true.
   */
  it('constructed URI always includes retryWrites=false and directConnection=true', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        fc.oneof(arbCaPath(), fc.constant(null)),
        (endpoint, username, password, caPath) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(caPath);

          expect(uri).toContain('retryWrites=false');
          expect(uri).toContain('directConnection=true');
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * When DOCDB_URI is set, buildDocumentDbUri SHALL return it directly
   * regardless of caPath or other env vars.
   */
  it('returns DOCDB_URI directly when set, bypassing composition', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10, maxLength: 100 }),
        fc.oneof(arbCaPath(), fc.constant(null)),
        (fullUri, caPath) => {
          process.env.DOCDB_URI = fullUri;
          process.env.DOCDB_CLUSTER_ENDPOINT = 'should-not-be-used.example.com';
          process.env.DOCDB_USERNAME = 'ignored';
          process.env.DOCDB_PASSWORD = 'ignored';

          const uri = buildDocumentDbUri(caPath);

          expect(uri).toBe(fullUri);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * When TLS is enabled (caPath provided), the URI SHALL include tls=true
   * and tlsCAFile={caPath} query parameters.
   */
  it('includes tls=true and tlsCAFile when caPath is provided', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        arbCaPath(),
        (endpoint, username, password, caPath) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(caPath);

          expect(uri).toContain('tls=true');
          expect(uri).toContain(`tlsCAFile=${caPath}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 9.3, 9.4**
   *
   * When TLS is disabled (caPath is null), the URI SHALL NOT include
   * tls=true or tlsCAFile query parameters.
   */
  it('does not include tls params when caPath is null', () => {
    fc.assert(
      fc.property(
        arbEndpoint(),
        arbUsername(),
        arbPassword(),
        (endpoint, username, password) => {
          process.env.DOCDB_CLUSTER_ENDPOINT = endpoint;
          process.env.DOCDB_USERNAME = username;
          process.env.DOCDB_PASSWORD = password;
          delete process.env.DOCDB_URI;

          const uri = buildDocumentDbUri(null);

          expect(uri).not.toContain('tls=true');
          expect(uri).not.toContain('tlsCAFile');
        }
      ),
      { numRuns: 100 }
    );
  });
});
