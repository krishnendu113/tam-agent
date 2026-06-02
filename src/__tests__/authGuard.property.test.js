import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// --- Extraction functions (isolated from public/index.html inline script) ---

/**
 * Simulates the token extraction logic from the login page.
 * Given a URL hash string, extracts the token if the hash starts with '#token='.
 * @param {string} hash - The window.location.hash value
 * @returns {string|null} The extracted token, or null if not a token hash
 */
function extractTokenFromHash(hash) {
  if (hash && hash.indexOf('#token=') === 0) {
    const token = hash.substring(7);
    return token || null;
  }
  return null;
}

/**
 * Simulates the error extraction logic from the login page.
 * Given a URL hash string, extracts the error message if the hash starts with '#error='.
 * @param {string} hash - The window.location.hash value
 * @returns {string|null} The extracted error message, or null if not an error hash
 */
function extractErrorFromHash(hash) {
  if (hash && hash.indexOf('#error=') === 0) {
    const errorMsg = decodeURIComponent(hash.substring(7));
    return errorMsg || null;
  }
  return null;
}

// --- Generators ---

/**
 * Generates a valid JWT-like string: three dot-separated base64url segments.
 */
function arbJwtString() {
  const base64urlChar = fc.constantFrom(
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')
  );
  const base64urlSegment = fc.stringOf(base64urlChar, { minLength: 4, maxLength: 64 });
  return fc
    .tuple(base64urlSegment, base64urlSegment, base64urlSegment)
    .map(([header, payload, signature]) => `${header}.${payload}.${signature}`);
}

/**
 * Generates arbitrary error message strings (printable, URI-encodable).
 */
function arbErrorMessage() {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+[]{}|;:,.<>?/~`\'"'.split('')
    ),
    { minLength: 1, maxLength: 100 }
  );
}

// --- Property Tests ---

describe('Feature: frontend-auth-admin, Property 1: URL hash token extraction round-trip', () => {
  /**
   * Validates: Requirements 1.2, 1.4
   *
   * For any valid JWT string placed in the URL hash as #token=<jwt>,
   * the client auth module's extraction function SHALL return the exact same JWT string.
   */
  it('For any valid JWT string in #token=<jwt>, extraction returns the exact JWT string', () => {
    fc.assert(
      fc.property(arbJwtString(), (jwtString) => {
        const hash = `#token=${jwtString}`;
        const extracted = extractTokenFromHash(hash);
        expect(extracted).toBe(jwtString);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 1.2, 1.4
   *
   * For any error string placed as #error=<msg>, the extraction function
   * SHALL return the exact error message.
   */
  it('For any error message in #error=<msg>, extraction returns the exact error message', () => {
    fc.assert(
      fc.property(arbErrorMessage(), (errorMsg) => {
        const hash = `#error=${encodeURIComponent(errorMsg)}`;
        const extracted = extractErrorFromHash(hash);
        expect(extracted).toBe(errorMsg);
      }),
      { numRuns: 100 }
    );
  });
});


// --- Auth Guard simulation (mirrors public/js/auth.js logic) ---

/**
 * Creates a controlled auth module environment for testing requireAuth() behavior.
 * Simulates localStorage and window.location to observe side effects.
 */
function createAuthGuardEnv() {
  let storage = {};
  let locationHref = '';

  const localStorage = {
    getItem: (key) => storage[key] || null,
    setItem: (key, value) => { storage[key] = String(value); },
    removeItem: (key) => { delete storage[key]; },
  };

  const location = {
    get href() { return locationHref; },
    set href(val) { locationHref = val; },
  };

  const TOKEN_KEY = 'token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function getCurrentUser() {
    const token = getToken();
    if (!token) return null;

    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = parts[1];
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = atob(base64);
      const parsed = JSON.parse(decoded);

      return {
        email: parsed.email,
        name: parsed.name,
        role: parsed.role,
        exp: parsed.exp,
      };
    } catch (e) {
      return null;
    }
  }

  function isAuthenticated() {
    const user = getCurrentUser();
    if (!user) return false;
    const now = Math.floor(Date.now() / 1000);
    return user.exp > now;
  }

  function requireAuth() {
    if (!isAuthenticated()) {
      clearToken();
      location.href = '/index.html';
    }
  }

  return {
    storage,
    localStorage,
    location,
    setToken,
    getToken,
    clearToken,
    requireAuth,
    getLocationHref: () => locationHref,
  };
}

// --- Generators for invalid token states ---

/**
 * Generates a valid base64url-encoded JWT payload with a given exp timestamp.
 */
function makeTokenWithExp(exp) {
  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const body = JSON.stringify({ email: 'user@example.com', name: 'User', role: 'user', exp });
  const encodeBase64Url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encodeBase64Url(header)}.${encodeBase64Url(body)}.fake-sig`;
}

/**
 * Generates missing token states: null (empty localStorage).
 */
function arbMissingToken() {
  return fc.constant(null);
}

/**
 * Generates malformed tokens that are NOT valid 3-dot-separated JWT structures.
 * Includes: empty strings, strings without dots, strings with wrong number of segments.
 */
function arbMalformedTokenStructure() {
  const printableChar = fc.char().filter((c) => c !== '.');
  // Tokens with 0, 1, or 2 segments (not 3)
  const noDots = fc.stringOf(printableChar, { minLength: 1, maxLength: 50 });
  const oneDot = fc.tuple(
    fc.stringOf(printableChar, { minLength: 1, maxLength: 20 }),
    fc.stringOf(printableChar, { minLength: 1, maxLength: 20 })
  ).map(([a, b]) => `${a}.${b}`);
  const fourPlusDots = fc.tuple(
    fc.stringOf(printableChar, { minLength: 1, maxLength: 10 }),
    fc.stringOf(printableChar, { minLength: 1, maxLength: 10 }),
    fc.stringOf(printableChar, { minLength: 1, maxLength: 10 }),
    fc.stringOf(printableChar, { minLength: 1, maxLength: 10 })
  ).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

  return fc.oneof(noDots, oneDot, fourPlusDots);
}

/**
 * Generates tokens with 3 dot-separated parts but invalid base64 payload
 * (cannot be decoded to valid JSON with an exp field).
 */
function arbMalformedPayload() {
  // Generate random non-base64 characters in the payload segment
  const invalidBase64Char = fc.constantFrom(...'!@#$%^&*()[]{}|;:<>?'.split(''));
  const invalidPayload = fc.stringOf(invalidBase64Char, { minLength: 2, maxLength: 30 });
  const segment = fc.stringOf(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 4, maxLength: 20 }
  );

  return fc.tuple(segment, invalidPayload, segment)
    .map(([header, payload, sig]) => `${header}.${payload}.${sig}`);
}

/**
 * Generates tokens with valid structure but payload JSON missing the exp field.
 */
function arbMissingExpField() {
  const encodeBase64Url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return fc.record({
    email: fc.emailAddress(),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    role: fc.constantFrom('user', 'admin'),
  }).map((payload) => {
    // Deliberately omit exp field
    const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = encodeBase64Url(JSON.stringify(payload));
    return `${header}.${body}.fake-sig`;
  });
}

/**
 * Generates expired tokens (exp in the past).
 */
function arbExpiredToken() {
  const now = Math.floor(Date.now() / 1000);
  // Generate exp values from 1 second ago to 1 year ago
  return fc.integer({ min: now - 365 * 24 * 3600, max: now - 1 })
    .map((exp) => makeTokenWithExp(exp));
}

// --- Property 4 Tests ---

describe('Feature: frontend-auth-admin, Property 4: Auth guard blocks all invalid tokens', () => {
  /**
   * Validates: Requirements 3.1, 3.2, 3.4
   *
   * For any token state that is missing, malformed, or expired,
   * the client-side auth guard SHALL redirect the user to the Login Page
   * and clear any stored token from localStorage.
   */

  it('Missing token (null/empty localStorage) → redirects to /index.html and clears token', () => {
    fc.assert(
      fc.property(arbMissingToken(), (_nullToken) => {
        const env = createAuthGuardEnv();
        // Do not set any token — localStorage is empty
        env.requireAuth();

        expect(env.getLocationHref()).toBe('/index.html');
        expect(env.getToken()).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('Malformed tokens (not 3 dot-separated parts) → redirects to /index.html and clears token', () => {
    fc.assert(
      fc.property(arbMalformedTokenStructure(), (malformedToken) => {
        const env = createAuthGuardEnv();
        env.setToken(malformedToken);
        env.requireAuth();

        expect(env.getLocationHref()).toBe('/index.html');
        expect(env.getToken()).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('Malformed tokens (invalid base64 payload) → redirects to /index.html and clears token', () => {
    fc.assert(
      fc.property(arbMalformedPayload(), (malformedToken) => {
        const env = createAuthGuardEnv();
        env.setToken(malformedToken);
        env.requireAuth();

        expect(env.getLocationHref()).toBe('/index.html');
        expect(env.getToken()).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('Malformed tokens (missing exp field in payload) → redirects to /index.html and clears token', () => {
    fc.assert(
      fc.property(arbMissingExpField(), (tokenWithoutExp) => {
        const env = createAuthGuardEnv();
        env.setToken(tokenWithoutExp);
        env.requireAuth();

        expect(env.getLocationHref()).toBe('/index.html');
        expect(env.getToken()).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('Expired tokens (exp in the past) → redirects to /index.html and clears token', () => {
    fc.assert(
      fc.property(arbExpiredToken(), (expiredToken) => {
        const env = createAuthGuardEnv();
        env.setToken(expiredToken);
        env.requireAuth();

        expect(env.getLocationHref()).toBe('/index.html');
        expect(env.getToken()).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});
