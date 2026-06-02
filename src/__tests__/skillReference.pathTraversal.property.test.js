/**
 * Property-based tests for path traversal prevention in loadReferenceFile
 *
 * Property 4: Reference File Path Traversal Prevention
 *
 * For any fileName input (including `../`, absolute paths, encoded sequences,
 * null bytes), resolved path SHALL always begin with skill directory prefix;
 * invalid inputs SHALL result in error.
 *
 * **Validates: Requirements 3.6**
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

describe('Feature: skill-system-enhancement, Property 4: Reference File Path Traversal Prevention', () => {
  let loadReferenceFile;
  let clearCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../skillLoader.js');
    loadReferenceFile = mod.loadReferenceFile;
    clearCache = mod.clearCache;
    clearCache();
  });

  // --- Generators ---

  /**
   * Generates paths containing `../` at various positions.
   */
  function arbDotDotPaths() {
    return fc.oneof(
      fc.constant('../../../etc/passwd'),
      fc.constant('../../secret.txt'),
      fc.constant('references/../../../etc/shadow'),
      fc.constant('foo/../../../bar'),
      fc.constant('../SKILL.md'),
      fc.constant('references/../../outside.md'),
      fc.constant('..'),
      fc.constant('../'),
      // Generate with random prefix/suffix around ..
      fc.tuple(
        fc.stringMatching(/^[a-z]{1,10}$/),
        fc.stringMatching(/^[a-z]{1,10}$/)
      ).map(([prefix, suffix]) => `${prefix}/../../../${suffix}`)
    );
  }

  /**
   * Generates absolute paths starting with `/`.
   */
  function arbAbsolutePaths() {
    return fc.oneof(
      fc.constant('/etc/passwd'),
      fc.constant('/etc/shadow'),
      fc.constant('/tmp/malicious'),
      fc.constant('/root/.ssh/id_rsa'),
      fc.constant('/var/log/syslog'),
      fc.stringMatching(/^\/[a-z]{1,5}(\/[a-z]{1,5}){1,4}$/)
    );
  }

  /**
   * Generates paths with URL-encoded traversal sequences.
   */
  function arbEncodedPaths() {
    return fc.oneof(
      fc.constant('%2e%2e/%2e%2e/etc/passwd'),
      fc.constant('%2e%2e%2f%2e%2e%2fetc%2fpasswd'),
      fc.constant('%2E%2E/%2E%2E/secret'),
      fc.constant('references/%2e%2e/%2e%2e/outside'),
      fc.constant('%2f%2f%2f%2fetc/passwd'),
      fc.constant('foo%2f..%2f..%2fbar'),
      fc.constant('%2F..%2F..%2Fetc%2Fpasswd'),
      fc.constant('%2e%2e'),
      fc.constant('%2E%2E'),
      fc.constant('%2f'),
      fc.constant('%2F')
    );
  }

  /**
   * Generates paths with null bytes.
   */
  function arbNullBytePaths() {
    return fc.oneof(
      fc.constant('file.md\0.jpg'),
      fc.constant('\0malicious'),
      fc.constant('references/\0../etc/passwd'),
      fc.constant('normal.md\0'),
      fc.stringMatching(/^[a-z]{1,5}$/).map(s => s + '\0' + '.md'),
      fc.stringMatching(/^[a-z]{1,5}$/).map(s => '\0' + s)
    );
  }

  /**
   * Generates very long paths that might overflow or confuse path resolution.
   */
  function arbLongPaths() {
    return fc.stringMatching(/^[a-z]{200,500}$/).map(s => s + '.md');
  }

  /**
   * Generates paths with Windows-style separators.
   */
  function arbWindowsPaths() {
    return fc.oneof(
      fc.constant('..\\..\\etc\\passwd'),
      fc.constant('references\\..\\..\\secret'),
      fc.constant('\\etc\\passwd'),
      fc.constant('foo\\..\\..\\bar'),
      fc.constant('..\\SKILL.md')
    );
  }

  /**
   * Generates combined traversal attempts mixing multiple techniques.
   */
  function arbCombinedTraversals() {
    return fc.oneof(
      fc.constant('../%2e%2e/etc/passwd'),
      fc.constant('%2e%2e/\0../secret'),
      fc.constant('/etc/../../../passwd'),
      fc.constant('....//....//etc/passwd'),
      fc.constant('./../../etc/passwd'),
      fc.constant('references/../references/../../etc/passwd'),
      fc.constant('.%2e/.%2e/etc/passwd')
    );
  }

  /**
   * A unified generator for all malicious path inputs.
   */
  function arbMaliciousPath() {
    return fc.oneof(
      arbDotDotPaths(),
      arbAbsolutePaths(),
      arbEncodedPaths(),
      arbNullBytePaths(),
      arbWindowsPaths(),
      arbCombinedTraversals()
    );
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 3.6**
   *
   * For any fileName containing `../` segments, loadReferenceFile SHALL throw
   * an error and never succeed.
   */
  it('rejects all paths containing `../` traversal segments', () => {
    fc.assert(
      fc.property(
        arbDotDotPaths(),
        (maliciousPath) => {
          expect(() => loadReferenceFile('brd', maliciousPath)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any absolute path starting with `/`, loadReferenceFile SHALL throw an error.
   */
  it('rejects all absolute paths starting with `/`', () => {
    fc.assert(
      fc.property(
        arbAbsolutePaths(),
        (absolutePath) => {
          expect(() => loadReferenceFile('brd', absolutePath)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any path with encoded traversal sequences (%2e, %2E, %2f, %2F),
   * loadReferenceFile SHALL throw an error.
   */
  it('rejects all paths with URL-encoded traversal sequences', () => {
    fc.assert(
      fc.property(
        arbEncodedPaths(),
        (encodedPath) => {
          expect(() => loadReferenceFile('brd', encodedPath)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any path containing null bytes, loadReferenceFile SHALL throw an error.
   */
  it('rejects all paths containing null bytes', () => {
    fc.assert(
      fc.property(
        arbNullBytePaths(),
        (nullBytePath) => {
          expect(() => loadReferenceFile('brd', nullBytePath)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any Windows-style path with backslash separators, loadReferenceFile
   * SHALL either throw an error or resolve safely within the skill directory.
   */
  it('rejects paths with Windows-style backslash traversal', () => {
    fc.assert(
      fc.property(
        arbWindowsPaths(),
        (windowsPath) => {
          // Windows-style paths with `..` should be rejected
          // Those starting with `\` are absolute paths and should be rejected
          expect(() => loadReferenceFile('brd', windowsPath)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any combined traversal attempt, loadReferenceFile SHALL throw an error.
   */
  it('rejects combined traversal attempts', () => {
    fc.assert(
      fc.property(
        arbCombinedTraversals(),
        (combinedPath) => {
          expect(() => loadReferenceFile('brd', combinedPath)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * For any malicious fileName input from the unified generator,
   * loadReferenceFile SHALL always throw an error — never succeed.
   */
  it('never allows access outside the skill directory for any malicious input', () => {
    fc.assert(
      fc.property(
        arbMaliciousPath(),
        (maliciousPath) => {
          expect(() => loadReferenceFile('brd', maliciousPath)).toThrow();
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * Error messages from path traversal attempts SHALL clearly indicate a
   * security rejection rather than a generic file-not-found error.
   */
  it('error messages indicate path traversal detection for `..` and absolute paths', () => {
    fc.assert(
      fc.property(
        fc.oneof(arbDotDotPaths(), arbAbsolutePaths()),
        (maliciousPath) => {
          try {
            loadReferenceFile('brd', maliciousPath);
            // Should never reach here
            expect.fail('Expected loadReferenceFile to throw');
          } catch (err) {
            expect(err.message.toLowerCase()).toMatch(/traversal|invalid|outside/);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
