import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Mock db module
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockCollection = vi.fn(() => ({
  findOne: mockFindOne,
  updateOne: mockUpdateOne,
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
}));

// Mock lockout module
const mockIsLocked = vi.fn().mockReturnValue(false);
const mockRecordFailedAttempt = vi.fn().mockReturnValue({ locked: false, attemptsRemaining: 4 });
const mockResetLockout = vi.fn();

vi.mock('../lockout.js', () => ({
  isLocked: (...args) => mockIsLocked(...args),
  recordFailedAttempt: (...args) => mockRecordFailedAttempt(...args),
  resetLockout: (...args) => mockResetLockout(...args),
}));

import { adminLoginHandler } from '../adminAuth.js';

// --- Helpers ---

function createMockReq(body = {}) {
  return { body };
}

function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// --- Generators ---

/**
 * Generates a valid password string (printable ASCII, reasonable length).
 * Passwords must be non-empty and not contain control characters.
 */
function arbPassword() {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:,.<>?/~`'.split('')
    ),
    { minLength: 6, maxLength: 40 }
  );
}

/**
 * Generates a random email that is NOT the admin email.
 */
function arbNonAdminEmail() {
  return fc
    .tuple(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 3,
        maxLength: 15,
      }),
      fc.constantFrom('example.com', 'test.org', 'random.io', 'other.net')
    )
    .map(([local, domain]) => `${local}@${domain}`);
}

/**
 * Generates a random password that is guaranteed to differ from a given password.
 */
function arbWrongPassword(correctPassword) {
  return arbPassword().filter((p) => p !== correctPassword);
}

// --- Property Tests ---

describe('Feature: frontend-auth-admin, Property 2: Valid admin credentials produce a JWT with correct role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLocked.mockReturnValue(false);
    mockRecordFailedAttempt.mockReturnValue({ locked: false, attemptsRemaining: 4 });
  });

  /**
   * Validates: Requirements 2.2, 14.1, 14.4
   *
   * For any valid password that matches the bcrypt hash stored for the admin user,
   * a POST to /api/auth/admin-login with the correct email and that password
   * SHALL return a 200 response containing a JWT whose decoded payload includes
   * role: "admin" and the admin's email.
   */
  it('For any valid password matching the stored bcrypt hash, login returns 200 with JWT containing role "admin" and admin email', async () => {
    await fc.assert(
      fc.asyncProperty(arbPassword(), async (password) => {
        vi.clearAllMocks();
        mockIsLocked.mockReturnValue(false);

        const adminEmail = 'admin@capillarytech.com';
        // Use low salt rounds (4) for testing to avoid timeout — bcrypt with 10 rounds is too slow for 100 iterations
        const passwordHash = await bcrypt.hash(password, 4);

        mockFindOne.mockResolvedValue({
          email: adminEmail,
          name: 'Admin',
          role: 'admin',
          status: 'active',
          passwordHash,
        });
        mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

        const req = createMockReq({ email: adminEmail, password });
        const res = createMockRes();

        await adminLoginHandler(req, res);

        // Must return 200
        expect(res.statusCode).toBe(200);

        // Must return a token
        expect(res.body).toBeDefined();
        expect(res.body.token).toBeDefined();
        expect(typeof res.body.token).toBe('string');

        // Decode and verify JWT payload
        const decoded = jwt.verify(res.body.token, JWT_SECRET);
        expect(decoded.role).toBe('admin');
        expect(decoded.email).toBe(adminEmail);

        // Lockout should be reset on success
        expect(mockResetLockout).toHaveBeenCalledWith(adminEmail);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: frontend-auth-admin, Property 3: Invalid credentials are always rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLocked.mockReturnValue(false);
    mockRecordFailedAttempt.mockReturnValue({ locked: false, attemptsRemaining: 4 });
  });

  /**
   * Validates: Requirements 2.3, 14.2
   *
   * For any email that does not belong to an admin user,
   * a POST to /api/auth/admin-login SHALL return a 401 status
   * with a generic "Invalid credentials" message.
   */
  it('For any non-admin email, login returns 401 with "Invalid credentials"', async () => {
    await fc.assert(
      fc.asyncProperty(arbNonAdminEmail(), arbPassword(), async (email, password) => {
        vi.clearAllMocks();
        mockIsLocked.mockReturnValue(false);

        // User not found in database
        mockFindOne.mockResolvedValue(null);

        const req = createMockReq({ email, password });
        const res = createMockRes();

        await adminLoginHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Validates: Requirements 2.3, 14.3
   *
   * For any password that does not match the stored bcrypt hash,
   * a POST to /api/auth/admin-login SHALL return a 401 status
   * with a generic "Invalid credentials" message.
   */
  it('For any wrong password, login returns 401 with "Invalid credentials"', async () => {
    // Pre-compute a fixed correct password and its hash for the test
    const correctPassword = 'CorrectPassword123!';
    const passwordHash = await bcrypt.hash(correctPassword, 10);

    await fc.assert(
      fc.asyncProperty(arbWrongPassword(correctPassword), async (wrongPassword) => {
        vi.clearAllMocks();
        mockIsLocked.mockReturnValue(false);

        const adminEmail = 'admin@capillarytech.com';

        mockFindOne.mockResolvedValue({
          email: adminEmail,
          name: 'Admin',
          role: 'admin',
          status: 'active',
          passwordHash,
        });

        const req = createMockReq({ email: adminEmail, password: wrongPassword });
        const res = createMockRes();

        await adminLoginHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
        expect(mockRecordFailedAttempt).toHaveBeenCalledWith(adminEmail);
      }),
      { numRuns: 100 }
    );
  });
});
