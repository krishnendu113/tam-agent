import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { ObjectId } from 'mongodb';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// --- Mock Setup ---

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockFind = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockCollection = vi.fn(() => ({
  findOne: mockFindOne,
  updateOne: mockUpdateOne,
  find: mockFind,
  findOneAndUpdate: mockFindOneAndUpdate,
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  connectDb: vi.fn(),
  closeDb: vi.fn(),
}));

const mockIsLocked = vi.fn().mockReturnValue(false);
const mockRecordFailedAttempt = vi.fn().mockReturnValue({ locked: false, attemptsRemaining: 4 });
const mockResetLockout = vi.fn();

vi.mock('../lockout.js', () => ({
  isLocked: (...args) => mockIsLocked(...args),
  recordFailedAttempt: (...args) => mockRecordFailedAttempt(...args),
  resetLockout: (...args) => mockResetLockout(...args),
}));

import { adminLoginHandler, adminMiddleware, enhancedAuthMiddleware } from '../adminAuth.js';
import adminRouter from '../adminRoutes.js';

// --- Helpers ---

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

/**
 * Simulates a PATCH /api/admin/users/:id request through the admin router.
 * We call the route handler directly to avoid needing a full Express app.
 */
async function simulatePatch(adminEmail, targetId, body) {
  const req = {
    params: { id: targetId.toString() },
    body,
    user: { email: adminEmail, role: 'admin' },
  };
  const res = createMockRes();

  // Extract the PATCH handler from the router stack
  const patchLayer = adminRouter.stack.find(
    (layer) => layer.route && layer.route.path === '/:id' && layer.route.methods.patch
  );
  const handler = patchLayer.route.stack[0].handle;
  await handler(req, res);
  return res;
}

/**
 * Simulates a GET /api/admin/users request through the admin router.
 */
async function simulateGetUsers(userEmail, userRole) {
  const req = {
    user: { email: userEmail, role: userRole },
  };
  const res = createMockRes();

  const getLayer = adminRouter.stack.find(
    (layer) => layer.route && layer.route.path === '/' && layer.route.methods.get
  );
  const handler = getLayer.route.stack[0].handle;
  await handler(req, res);
  return res;
}

// --- Generators ---

/**
 * Generates a valid user email address.
 */
function arbEmail() {
  return fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 3, maxLength: 12 }),
    fc.constantFrom('example.com', 'test.org', 'company.io', 'capillarytech.com')
  ).map(([local, domain]) => `${local}@${domain}`);
}

/**
 * Generates a valid user name.
 */
function arbName() {
  return fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '.split('')),
    { minLength: 2, maxLength: 30 }
  );
}

/**
 * Generates a user record with active status.
 */
function arbActiveUser() {
  return fc.record({
    _id: fc.constant(new ObjectId()),
    email: arbEmail(),
    name: arbName(),
    role: fc.constantFrom('user', 'admin'),
    status: fc.constant('active'),
    createdAt: fc.constant(new Date('2024-01-01')),
    lastLoginAt: fc.constant(new Date('2024-06-01')),
  });
}

/**
 * Generates a user record with role "user" specifically.
 */
function arbRegularUser() {
  return fc.record({
    _id: fc.constant(new ObjectId()),
    email: arbEmail(),
    name: arbName(),
    role: fc.constant('user'),
    status: fc.constant('active'),
    createdAt: fc.constant(new Date('2024-01-01')),
    lastLoginAt: fc.constant(new Date('2024-06-01')),
  });
}

/**
 * Generates a disabled user record with a valid password hash.
 * The passwordHash is set to a known bcrypt hash so we can test the disabled check path.
 */
function arbDisabledUser() {
  return fc.record({
    _id: fc.constant(new ObjectId()),
    email: arbEmail(),
    name: arbName(),
    role: fc.constantFrom('user', 'admin'),
    status: fc.constant('disabled'),
    createdAt: fc.constant(new Date('2024-01-01')),
    lastLoginAt: fc.constant(new Date('2024-06-01')),
  });
}

/**
 * Generates an admin user email that is different from the target user.
 */
function arbAdminEmail() {
  return fc.constant('admin@capillarytech.com');
}

// --- Property Tests ---

describe('Feature: frontend-auth-admin, Property 6: User status enable/disable round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 11.2, 11.3
   *
   * For any user record, disabling an active user and then enabling them
   * SHALL restore the user's status to "active", and the intermediate disabled
   * state SHALL block that user's authentication attempts.
   */
  it('disabling an active user and re-enabling restores status to active, and intermediate disabled state blocks auth', async () => {
    await fc.assert(
      fc.asyncProperty(arbActiveUser(), async (user) => {
        // Ensure the admin is different from the target user
        const adminEmail = 'admin-operator@capillarytech.com';
        const userId = new ObjectId();
        const targetUser = { ...user, _id: userId };

        // Step 1: Disable the user
        mockFindOne.mockResolvedValueOnce(targetUser); // find target user
        mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // update
        const disabledUser = { ...targetUser, status: 'disabled' };
        mockFindOne.mockResolvedValueOnce(disabledUser); // return updated user

        const disableRes = await simulatePatch(adminEmail, userId, { status: 'disabled' });
        expect(disableRes.statusCode).toBe(200);
        expect(disableRes.body.user.status).toBe('disabled');

        // Step 2: Verify the intermediate disabled state blocks authentication
        // Simulate enhancedAuthMiddleware check with a valid JWT for the disabled user
        const token = jwt.sign(
          { email: targetUser.email, name: targetUser.name, role: targetUser.role },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
        mockFindOne.mockResolvedValueOnce({ ...targetUser, status: 'disabled' });

        const authReq = { headers: { authorization: `Bearer ${token}` } };
        const authRes = createMockRes();
        const next = vi.fn();

        await enhancedAuthMiddleware(authReq, authRes, next);
        expect(authRes.statusCode).toBe(403);
        expect(authRes.body.error).toBe('Account is disabled');
        expect(next).not.toHaveBeenCalled();

        // Step 3: Re-enable the user
        mockFindOne.mockResolvedValueOnce(disabledUser); // find target user (disabled)
        mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // update
        const reEnabledUser = { ...targetUser, status: 'active' };
        mockFindOne.mockResolvedValueOnce(reEnabledUser); // return updated user

        const enableRes = await simulatePatch(adminEmail, userId, { status: 'active' });
        expect(enableRes.statusCode).toBe(200);
        expect(enableRes.body.user.status).toBe('active');
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: frontend-auth-admin, Property 7: User role promote/demote round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 11.4, 11.5
   *
   * For any user record with role "user", promoting to "admin" and then demoting
   * back SHALL restore the role to "user", and the intermediate admin state SHALL
   * grant access to admin endpoints.
   */
  it('promoting a user to admin and demoting back restores role, and intermediate admin state grants admin access', async () => {
    await fc.assert(
      fc.asyncProperty(arbRegularUser(), async (user) => {
        const adminEmail = 'admin-operator@capillarytech.com';
        const userId = new ObjectId();
        const targetUser = { ...user, _id: userId };

        // Step 1: Promote user to admin
        mockFindOne.mockResolvedValueOnce(targetUser); // find target user
        mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // update
        const promotedUser = { ...targetUser, role: 'admin' };
        mockFindOne.mockResolvedValueOnce(promotedUser); // return updated user

        const promoteRes = await simulatePatch(adminEmail, userId, { role: 'admin' });
        expect(promoteRes.statusCode).toBe(200);
        expect(promoteRes.body.user.role).toBe('admin');

        // Step 2: Verify intermediate admin state grants access to admin endpoints
        const adminReq = { user: { email: targetUser.email, role: 'admin' } };
        const adminRes = createMockRes();
        const next = vi.fn();

        adminMiddleware(adminReq, adminRes, next);
        expect(next).toHaveBeenCalled();

        // Step 3: Demote back to user
        mockFindOne.mockResolvedValueOnce(promotedUser); // find target user (admin)
        mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // update
        const demotedUser = { ...targetUser, role: 'user' };
        mockFindOne.mockResolvedValueOnce(demotedUser); // return updated user

        const demoteRes = await simulatePatch(adminEmail, userId, { role: 'user' });
        expect(demoteRes.statusCode).toBe(200);
        expect(demoteRes.body.user.role).toBe('user');
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: frontend-auth-admin, Property 8: Disabled users are blocked on all access paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 12.1, 12.2, 12.3
   *
   * For any user with status "disabled", authentication via Google OAuth SHALL be
   * rejected, authentication via admin password login SHALL be rejected, and
   * presenting a valid JWT for that user to any protected endpoint SHALL return 403.
   */
  it('disabled users are blocked via admin password login, Google OAuth, and JWT on protected endpoints', async () => {
    // Pre-compute a bcrypt hash once to avoid repeated hashing in the loop
    const knownPassword = 'testpassword123';
    const precomputedHash = await bcrypt.hash(knownPassword, 4);

    await fc.assert(
      fc.asyncProperty(arbDisabledUser(), async (user) => {
        const disabledUser = { ...user, _id: new ObjectId() };

        // Path 1: Admin password login rejects disabled user
        // The user has a valid passwordHash but status is 'disabled'
        // adminLoginHandler checks status === 'disabled' AFTER finding user with passwordHash
        mockIsLocked.mockReturnValue(false);
        mockFindOne.mockResolvedValueOnce({
          ...disabledUser,
          passwordHash: precomputedHash,
        });

        const loginReq = { body: { email: disabledUser.email, password: knownPassword } };
        const loginRes = createMockRes();
        await adminLoginHandler(loginReq, loginRes);

        expect(loginRes.statusCode).toBe(403);
        expect(loginRes.body.error).toBe('Account is disabled');

        // Path 2: Google OAuth rejects disabled user
        // The handleGoogleCallback function checks user.status === 'disabled' after upsert
        // and throws 'Account is disabled'. We verify the pattern by checking that
        // the enhancedAuthMiddleware (which also does a DB lookup) blocks the user.
        // The actual Google OAuth disabled check is tested in googleOAuthCallback.test.js.

        // Path 3: Valid JWT for disabled user on protected endpoint returns 403
        const token = jwt.sign(
          { email: disabledUser.email, name: disabledUser.name, role: disabledUser.role },
          JWT_SECRET,
          { expiresIn: '1h' }
        );
        mockFindOne.mockResolvedValueOnce(disabledUser);

        const authReq = { headers: { authorization: `Bearer ${token}` } };
        const authRes = createMockRes();
        const next = vi.fn();

        await enhancedAuthMiddleware(authReq, authRes, next);
        expect(authRes.statusCode).toBe(403);
        expect(authRes.body.error).toBe('Account is disabled');
        expect(next).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: frontend-auth-admin, Property 12: Admin endpoint role-based access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 13.1, 13.3
   *
   * For any user with role "user", requests to /api/admin/users and
   * /api/admin/users/:id SHALL return 403, and for any user with role "admin",
   * the same endpoints SHALL return successful responses.
   */
  it('non-admin users are rejected by adminMiddleware, admin users are granted access', async () => {
    await fc.assert(
      fc.asyncProperty(arbEmail(), arbName(), async (email, name) => {
        // Test 1: User with role "user" is blocked by adminMiddleware
        const userReq = { user: { email, name, role: 'user' } };
        const userRes = createMockRes();
        const userNext = vi.fn();

        adminMiddleware(userReq, userRes, userNext);
        expect(userRes.statusCode).toBe(403);
        expect(userRes.body.error).toBe('Admin access required');
        expect(userNext).not.toHaveBeenCalled();

        // Test 2: User with role "admin" passes adminMiddleware
        const adminReq = { user: { email, name, role: 'admin' } };
        const adminRes = createMockRes();
        const adminNext = vi.fn();

        adminMiddleware(adminReq, adminRes, adminNext);
        expect(adminNext).toHaveBeenCalled();

        // Test 3: Admin can successfully call GET /api/admin/users
        const mockUsers = [
          { _id: new ObjectId(), email: 'user1@test.com', name: 'User 1', role: 'user', status: 'active' },
          { _id: new ObjectId(), email: 'user2@test.com', name: 'User 2', role: 'admin', status: 'active' },
        ];
        mockFind.mockReturnValueOnce({
          toArray: vi.fn().mockResolvedValueOnce(mockUsers),
        });

        const getRes = await simulateGetUsers(email, 'admin');
        expect(getRes.statusCode).toBe(200);
        expect(getRes.body).toEqual(mockUsers);

        // Test 4: Admin can successfully call PATCH /api/admin/users/:id
        const targetId = new ObjectId();
        const targetUser = { _id: targetId, email: 'target@test.com', name: 'Target', role: 'user', status: 'active' };
        mockFindOne.mockResolvedValueOnce(targetUser); // find target
        mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // update
        mockFindOne.mockResolvedValueOnce({ ...targetUser, role: 'admin' }); // return updated

        const patchRes = await simulatePatch(email, targetId, { role: 'admin' });
        expect(patchRes.statusCode).toBe(200);
        expect(patchRes.body.user.role).toBe('admin');
      }),
      { numRuns: 100 }
    );
  });
});
