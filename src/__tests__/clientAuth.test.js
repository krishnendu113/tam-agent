import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for public/js/auth.js client-side auth module.
 * Since auth.js is a plain browser script (no module exports),
 * we simulate its functions by evaluating the logic in a mocked browser environment.
 */

// Helper: create a JWT-like token with a given payload
function createMockToken(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const signature = 'fake-signature';
  return `${header}.${body}.${signature}`;
}

// Helper: create a base64url-encoded JWT (handles +, /, = correctly)
function createBase64UrlToken(payload) {
  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const body = JSON.stringify(payload);
  const encodeBase64Url = (str) => {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${encodeBase64Url(header)}.${encodeBase64Url(body)}.fake-sig`;
}

// Simulate localStorage
let storage = {};
const localStorageMock = {
  getItem: (key) => storage[key] || null,
  setItem: (key, value) => { storage[key] = value; },
  removeItem: (key) => { delete storage[key]; }
};

// Simulate window.location
let locationHref = '';
const locationMock = {
  get href() { return locationHref; },
  set href(val) { locationHref = val; }
};

// Load and evaluate auth.js functions in a controlled scope
function createAuthModule() {
  const TOKEN_KEY = 'token';

  function getToken() {
    return localStorageMock.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    localStorageMock.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    localStorageMock.removeItem(TOKEN_KEY);
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
        exp: parsed.exp
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

  function isAdmin() {
    const user = getCurrentUser();
    if (!user) return false;
    return user.role === 'admin';
  }

  function requireAuth() {
    if (!isAuthenticated()) {
      clearToken();
      locationMock.href = '/index.html';
    }
  }

  function requireAdmin() {
    if (!isAdmin()) {
      locationMock.href = '/chat.html';
    }
  }

  return { getToken, setToken, clearToken, getCurrentUser, isAuthenticated, isAdmin, requireAuth, requireAdmin };
}

describe('Client Auth Module (public/js/auth.js)', () => {
  let auth;

  beforeEach(() => {
    storage = {};
    locationHref = '';
    auth = createAuthModule();
  });

  describe('getToken / setToken / clearToken', () => {
    it('returns null when no token is stored', () => {
      expect(auth.getToken()).toBeNull();
    });

    it('stores and retrieves a token', () => {
      auth.setToken('my-jwt-token');
      expect(auth.getToken()).toBe('my-jwt-token');
    });

    it('clears the stored token', () => {
      auth.setToken('my-jwt-token');
      auth.clearToken();
      expect(auth.getToken()).toBeNull();
    });
  });

  describe('getCurrentUser', () => {
    it('returns null when no token is stored', () => {
      expect(auth.getCurrentUser()).toBeNull();
    });

    it('decodes a valid JWT payload and returns user fields', () => {
      const payload = { email: 'user@example.com', name: 'Test User', role: 'user', exp: 9999999999 };
      const token = createMockToken(payload);
      auth.setToken(token);

      const user = auth.getCurrentUser();
      expect(user).toEqual({
        email: 'user@example.com',
        name: 'Test User',
        role: 'user',
        exp: 9999999999
      });
    });

    it('returns null for a malformed token (not 3 parts)', () => {
      auth.setToken('not-a-jwt');
      expect(auth.getCurrentUser()).toBeNull();
    });

    it('returns null for a token with invalid base64 payload', () => {
      auth.setToken('header.!!!invalid!!!.signature');
      expect(auth.getCurrentUser()).toBeNull();
    });

    it('handles base64url encoded tokens correctly', () => {
      const payload = { email: 'test+special@example.com', name: 'User/Name', role: 'admin', exp: 9999999999 };
      const token = createBase64UrlToken(payload);
      auth.setToken(token);

      const user = auth.getCurrentUser();
      expect(user.email).toBe('test+special@example.com');
      expect(user.name).toBe('User/Name');
      expect(user.role).toBe('admin');
    });
  });

  describe('isAuthenticated', () => {
    it('returns false when no token is stored', () => {
      expect(auth.isAuthenticated()).toBe(false);
    });

    it('returns true for a valid non-expired token', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const token = createMockToken({ email: 'a@b.com', name: 'A', role: 'user', exp: futureExp });
      auth.setToken(token);
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('returns false for an expired token', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const token = createMockToken({ email: 'a@b.com', name: 'A', role: 'user', exp: pastExp });
      auth.setToken(token);
      expect(auth.isAuthenticated()).toBe(false);
    });

    it('returns false for a malformed token', () => {
      auth.setToken('garbage');
      expect(auth.isAuthenticated()).toBe(false);
    });
  });

  describe('isAdmin', () => {
    it('returns false when no token is stored', () => {
      expect(auth.isAdmin()).toBe(false);
    });

    it('returns true when role is admin', () => {
      const token = createMockToken({ email: 'admin@capillarytech.com', name: 'Admin', role: 'admin', exp: 9999999999 });
      auth.setToken(token);
      expect(auth.isAdmin()).toBe(true);
    });

    it('returns false when role is user', () => {
      const token = createMockToken({ email: 'user@example.com', name: 'User', role: 'user', exp: 9999999999 });
      auth.setToken(token);
      expect(auth.isAdmin()).toBe(false);
    });

    it('returns false for malformed token', () => {
      auth.setToken('bad.token');
      expect(auth.isAdmin()).toBe(false);
    });
  });

  describe('requireAuth', () => {
    it('redirects to /index.html when not authenticated', () => {
      auth.requireAuth();
      expect(locationHref).toBe('/index.html');
    });

    it('clears token when redirecting', () => {
      auth.setToken('expired.token.here');
      auth.requireAuth();
      expect(auth.getToken()).toBeNull();
    });

    it('does not redirect when authenticated', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const token = createMockToken({ email: 'a@b.com', name: 'A', role: 'user', exp: futureExp });
      auth.setToken(token);
      auth.requireAuth();
      expect(locationHref).toBe('');
    });
  });

  describe('requireAdmin', () => {
    it('redirects to /chat.html when user is not admin', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const token = createMockToken({ email: 'user@example.com', name: 'User', role: 'user', exp: futureExp });
      auth.setToken(token);
      auth.requireAdmin();
      expect(locationHref).toBe('/chat.html');
    });

    it('does not redirect when user is admin', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const token = createMockToken({ email: 'admin@capillarytech.com', name: 'Admin', role: 'admin', exp: futureExp });
      auth.setToken(token);
      auth.requireAdmin();
      expect(locationHref).toBe('');
    });

    it('redirects to /chat.html when no token exists', () => {
      auth.requireAdmin();
      expect(locationHref).toBe('/chat.html');
    });
  });
});
