import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Set env vars for OAuth BEFORE module import
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.ALLOWED_DOMAINS = 'capillarytech.com';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock db module
const mockFindOneAndUpdate = vi.fn();
const mockCollection = vi.fn(() => ({
  findOneAndUpdate: mockFindOneAndUpdate
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  connectDb: vi.fn(),
  closeDb: vi.fn()
}));

const { handleGoogleCallback } = await import('../auth.js');

describe('handleGoogleCallback - user record upsert and disabled check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockGoogleResponses(userInfo) {
    // Mock token exchange response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'mock-access-token' })
    });
    // Mock userinfo response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => userInfo
    });
  }

  it('upserts user record in users collection on successful OAuth', async () => {
    const userInfo = {
      email: 'user@capillarytech.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg'
    };
    mockGoogleResponses(userInfo);

    const userRecord = {
      email: 'user@capillarytech.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
      role: 'user',
      status: 'active',
      authProvider: 'google'
    };
    mockFindOneAndUpdate.mockResolvedValue(userRecord);

    const result = await handleGoogleCallback('test-code');

    // Verify upsert was called with correct parameters
    expect(mockCollection).toHaveBeenCalledWith('users');
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { email: 'user@capillarytech.com' },
      {
        $set: {
          name: 'Test User',
          picture: 'https://example.com/photo.jpg',
          authProvider: 'google',
          lastLoginAt: expect.any(Date),
          updatedAt: expect.any(Date)
        },
        $setOnInsert: {
          email: 'user@capillarytech.com',
          role: 'user',
          status: 'active',
          createdAt: expect.any(Date)
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    expect(result.token).toBeDefined();
    expect(result.user).toEqual(userInfo);
  });

  it('includes role in JWT payload', async () => {
    const userInfo = {
      email: 'user@capillarytech.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg'
    };
    mockGoogleResponses(userInfo);

    mockFindOneAndUpdate.mockResolvedValue({
      email: 'user@capillarytech.com',
      name: 'Test User',
      role: 'user',
      status: 'active'
    });

    const result = await handleGoogleCallback('test-code');
    const decoded = jwt.verify(result.token, JWT_SECRET);

    expect(decoded.email).toBe('user@capillarytech.com');
    expect(decoded.name).toBe('Test User');
    expect(decoded.role).toBe('user');
  });

  it('includes admin role in JWT when user has admin role', async () => {
    const userInfo = {
      email: 'admin@capillarytech.com',
      name: 'Admin',
      picture: 'https://example.com/admin.jpg'
    };
    mockGoogleResponses(userInfo);

    mockFindOneAndUpdate.mockResolvedValue({
      email: 'admin@capillarytech.com',
      name: 'Admin',
      role: 'admin',
      status: 'active'
    });

    const result = await handleGoogleCallback('test-code');
    const decoded = jwt.verify(result.token, JWT_SECRET);

    expect(decoded.role).toBe('admin');
  });

  it('throws "Account is disabled" when user status is disabled', async () => {
    const userInfo = {
      email: 'disabled@capillarytech.com',
      name: 'Disabled User',
      picture: 'https://example.com/disabled.jpg'
    };
    mockGoogleResponses(userInfo);

    mockFindOneAndUpdate.mockResolvedValue({
      email: 'disabled@capillarytech.com',
      name: 'Disabled User',
      role: 'user',
      status: 'disabled'
    });

    await expect(handleGoogleCallback('test-code')).rejects.toThrow('Account is disabled');
  });

  it('handles findOneAndUpdate returning result in value property', async () => {
    const userInfo = {
      email: 'user@capillarytech.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg'
    };
    mockGoogleResponses(userInfo);

    // Some MongoDB driver versions return { value: document }
    mockFindOneAndUpdate.mockResolvedValue({
      value: {
        email: 'user@capillarytech.com',
        name: 'Test User',
        role: 'user',
        status: 'active'
      }
    });

    const result = await handleGoogleCallback('test-code');
    const decoded = jwt.verify(result.token, JWT_SECRET);

    expect(decoded.role).toBe('user');
  });

  it('sets default role "user" and status "active" for new users via $setOnInsert', async () => {
    const userInfo = {
      email: 'newuser@capillarytech.com',
      name: 'New User',
      picture: 'https://example.com/new.jpg'
    };
    mockGoogleResponses(userInfo);

    mockFindOneAndUpdate.mockResolvedValue({
      email: 'newuser@capillarytech.com',
      name: 'New User',
      role: 'user',
      status: 'active',
      authProvider: 'google',
      createdAt: new Date()
    });

    const result = await handleGoogleCallback('test-code');

    // Verify the $setOnInsert contains defaults
    const upsertCall = mockFindOneAndUpdate.mock.calls[0];
    const updateDoc = upsertCall[1];
    expect(updateDoc.$setOnInsert.role).toBe('user');
    expect(updateDoc.$setOnInsert.status).toBe('active');
    expect(updateDoc.$setOnInsert.createdAt).toBeInstanceOf(Date);
  });
});
