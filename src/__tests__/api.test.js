import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for public/js/api.js
 * Since this is a plain browser JS file (no modules), we eval it in a mocked global context.
 */

// Read the source file
const apiSource = readFileSync(resolve(process.cwd(), 'public/js/api.js'), 'utf-8');

describe('API Wrapper Module (public/js/api.js)', () => {
  let mockFetch;
  let mockGetToken;
  let mockClearToken;
  let mockAlert;
  let mockLocation;
  let apiGet, apiPost, apiPatch, handleResponseErrors;

  beforeEach(() => {
    mockFetch = vi.fn();
    mockGetToken = vi.fn().mockReturnValue('test-jwt-token');
    mockClearToken = vi.fn();
    mockAlert = vi.fn();
    mockLocation = { href: '' };

    // Create a sandboxed context with browser globals
    const context = {
      fetch: mockFetch,
      getToken: mockGetToken,
      clearToken: mockClearToken,
      alert: mockAlert,
      window: { location: mockLocation },
    };

    // Evaluate the api.js source in our mock context
    const fn = new Function(
      ...Object.keys(context),
      `${apiSource}\nreturn { apiGet, apiPost, apiPatch, handleResponseErrors };`
    );
    const result = fn(...Object.values(context));
    apiGet = result.apiGet;
    apiPost = result.apiPost;
    apiPatch = result.apiPatch;
    handleResponseErrors = result.handleResponseErrors;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('apiGet', () => {
    it('should make a GET request with Authorization header', async () => {
      const mockResponse = { status: 200, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);

      const response = await apiGet('/api/conversations');

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer test-jwt-token'
        }
      });
      expect(response).toBe(mockResponse);
    });

    it('should use the token from getToken()', async () => {
      mockGetToken.mockReturnValue('my-special-token');
      const mockResponse = { status: 200, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);

      await apiGet('/api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer my-special-token'
        }
      });
    });
  });

  describe('apiPost', () => {
    it('should make a POST request with JSON body and auth header', async () => {
      const mockResponse = { status: 200, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);
      const body = { message: 'hello', conversationId: null };

      const response = await apiPost('/api/chat', body);

      expect(mockFetch).toHaveBeenCalledWith('/api/chat', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-jwt-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      expect(response).toBe(mockResponse);
    });
  });

  describe('apiPatch', () => {
    it('should make a PATCH request with JSON body and auth header', async () => {
      const mockResponse = { status: 200, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);
      const body = { status: 'disabled' };

      const response = await apiPatch('/api/admin/users/123', body);

      expect(mockFetch).toHaveBeenCalledWith('/api/admin/users/123', {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer test-jwt-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      expect(response).toBe(mockResponse);
    });
  });

  describe('401 handling (global interceptor)', () => {
    it('should clear token and redirect to login on 401', async () => {
      const mockResponse = { status: 401, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);

      await apiGet('/api/conversations');

      expect(mockClearToken).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/index.html');
    });

    it('should clear token and redirect on 401 for POST requests', async () => {
      const mockResponse = { status: 401, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);

      await apiPost('/api/chat', { message: 'test' });

      expect(mockClearToken).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/index.html');
    });

    it('should clear token and redirect on 401 for PATCH requests', async () => {
      const mockResponse = { status: 401, clone: () => mockResponse, json: () => Promise.resolve({}) };
      mockFetch.mockResolvedValue(mockResponse);

      await apiPatch('/api/admin/users/1', { status: 'active' });

      expect(mockClearToken).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/index.html');
    });
  });

  describe('403 handling (disabled account)', () => {
    it('should show alert and redirect when 403 indicates disabled account', async () => {
      const mockResponse = {
        status: 403,
        clone: () => ({ json: () => Promise.resolve({ error: 'Account is disabled' }) }),
        json: () => Promise.resolve({ error: 'Account is disabled' })
      };
      mockFetch.mockResolvedValue(mockResponse);

      await apiGet('/api/conversations');

      expect(mockAlert).toHaveBeenCalledWith('Your account has been disabled. Please contact an administrator.');
      expect(mockClearToken).toHaveBeenCalled();
      expect(mockLocation.href).toBe('/index.html');
    });

    it('should not alert or redirect for non-disabled 403 errors', async () => {
      const mockResponse = {
        status: 403,
        clone: () => ({ json: () => Promise.resolve({ error: 'Admin access required' }) }),
        json: () => Promise.resolve({ error: 'Admin access required' })
      };
      mockFetch.mockResolvedValue(mockResponse);

      await apiGet('/api/admin/users');

      expect(mockAlert).not.toHaveBeenCalled();
      expect(mockClearToken).not.toHaveBeenCalled();
    });

    it('should still return the response on 403 for caller handling', async () => {
      const mockResponse = {
        status: 403,
        clone: () => ({ json: () => Promise.resolve({ error: 'Admin access required' }) }),
        json: () => Promise.resolve({ error: 'Admin access required' })
      };
      mockFetch.mockResolvedValue(mockResponse);

      const response = await apiGet('/api/admin/users');

      expect(response).toBe(mockResponse);
    });

    it('should handle 403 gracefully when body is not JSON', async () => {
      const mockResponse = {
        status: 403,
        clone: () => ({ json: () => Promise.reject(new Error('not json')) }),
        json: () => Promise.reject(new Error('not json'))
      };
      mockFetch.mockResolvedValue(mockResponse);

      const response = await apiGet('/api/test');

      // Should not throw, should not alert
      expect(mockAlert).not.toHaveBeenCalled();
      expect(response).toBe(mockResponse);
    });
  });

  describe('successful responses', () => {
    it('should return the response object for 200 status', async () => {
      const mockResponse = { status: 200, clone: () => mockResponse, json: () => Promise.resolve({ data: 'test' }) };
      mockFetch.mockResolvedValue(mockResponse);

      const response = await apiGet('/api/conversations');

      expect(response).toBe(mockResponse);
      expect(mockClearToken).not.toHaveBeenCalled();
      expect(mockLocation.href).toBe('');
    });
  });
});
