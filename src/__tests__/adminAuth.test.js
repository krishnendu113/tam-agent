import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Mock db module
const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockInsertOne = vi.fn();
const mockCreateIndex = vi.fn();
const mockCollection = vi.fn(() => ({
  findOne: mockFindOne,
  updateOne: mockUpdateOne,
  insertOne: mockInsertOne,
  createIndex: mockCreateIndex
}));

vi.mock('../db.js', () => ({
  getDb: () => ({ collection: mockCollection }),
  connectDb: vi.fn(),
  closeDb: vi.fn()
}));

// Mock lockout module
const mockIsLocked = vi.fn().mockReturnValue(false);
const mockRecordFailedAttempt = vi.fn().mockReturnValue({ locked: false, attemptsRemaining: 4 });
const mockResetLockout = vi.fn();

vi.mock('../lockout.js', () => ({
  isLocked: (...args) => mockIsLocked(...args),
  recordFailedAttempt: (...args) => mockRecordFailedAttempt(...args),
  resetLockout: (...args) => mockResetLockout(...args)
}));

import {
  adminLoginHandler,
  adminMiddleware,
  enhancedAuthMiddleware,
  bootstrapSuperAdmin
} from '../adminAuth.js';

function createMockReq(body = {}, headers = {}) {
  return { body, headers };
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
    }
  };
  return res;
}

describe('adminLoginHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLocked.mockReturnValue(false);
    mockRecordFailedAttempt.mockReturnValue({ locked: false, attemptsRemaining: 4 });
  });

  it('returns 401 when email or password is missing', async () => {
    const req = createMockReq({ email: '', password: '' });
    const res = createMockRes();

    await adminLoginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('returns 423 when account is locked', async () => {
    mockIsLocked.mockReturnValue(true);
    const req = createMockReq({ email: 'admin@capillarytech.com', password: 'test' });
    const res = createMockRes();

    await adminLoginHandler(req, res);

    expect(res.statusCode).toBe(423);
    expect(res.body.error).toBe('Account locked');
    expect(res.body.retryAfter).toBe(900);
  });

  it('returns 401 when user not found', async () => {
    mockFindOne.mockResolvedValue(null);
    const req = createMockReq({ email: 'unknown@test.com', password: 'test' });
    const res = createMockRes();

    await adminLoginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(mockRecordFailedAttempt).toHaveBeenCalledWith('unknown@test.com');
  });

  it('returns 403 when user is disabled', async () => {
    mockFindOne.mockResolvedValue({
      email: 'admin@capillarytech.com',
      name: 'Admin',
      role: 'admin',
      status: 'disabled',
      passwordHash: await bcrypt.hash('password123', 10)
    });
    const req = createMockReq({ email: 'admin@capillarytech.com', password: 'password123' });
    const res = createMockRes();

    await adminLoginHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Account is disabled');
  });

  it('returns 401 when password is incorrect', async () => {
    mockFindOne.mockResolvedValue({
      email: 'admin@capillarytech.com',
      name: 'Admin',
      role: 'admin',
      status: 'active',
      passwordHash: await bcrypt.hash('correctpassword', 10)
    });
    const req = createMockReq({ email: 'admin@capillarytech.com', password: 'wrongpassword' });
    const res = createMockRes();

    await adminLoginHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(mockRecordFailedAttempt).toHaveBeenCalledWith('admin@capillarytech.com');
  });

  it('returns 200 with token on successful login', async () => {
    const passwordHash = await bcrypt.hash('correctpassword', 10);
    mockFindOne.mockResolvedValue({
      email: 'admin@capillarytech.com',
      name: 'Admin',
      role: 'admin',
      status: 'active',
      passwordHash
    });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const req = createMockReq({ email: 'admin@capillarytech.com', password: 'correctpassword' });
    const res = createMockRes();

    await adminLoginHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toEqual({
      email: 'admin@capillarytech.com',
      name: 'Admin',
      role: 'admin'
    });

    // Verify JWT payload
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.email).toBe('admin@capillarytech.com');
    expect(decoded.name).toBe('Admin');
    expect(decoded.role).toBe('admin');

    // Verify lockout was reset
    expect(mockResetLockout).toHaveBeenCalledWith('admin@capillarytech.com');
    // Verify lastLoginAt was updated
    expect(mockUpdateOne).toHaveBeenCalled();
  });
});

describe('adminMiddleware', () => {
  it('calls next() when user is admin', () => {
    const req = { user: { email: 'admin@capillarytech.com', role: 'admin' } };
    const res = createMockRes();
    const next = vi.fn();

    adminMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when user is not admin', () => {
    const req = { user: { email: 'user@test.com', role: 'user' } };
    const res = createMockRes();
    const next = vi.fn();

    adminMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Admin access required');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when req.user is missing', () => {
    const req = {};
    const res = createMockRes();
    const next = vi.fn();

    adminMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Admin access required');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('enhancedAuthMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when no authorization header', async () => {
    const req = { headers: {} };
    const res = createMockRes();
    const next = vi.fn();

    await enhancedAuthMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication required');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', async () => {
    const req = { headers: { authorization: 'Bearer invalid-token' } };
    const res = createMockRes();
    const next = vi.fn();

    await enhancedAuthMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user is disabled', async () => {
    const token = jwt.sign({ email: 'user@test.com', name: 'Test', role: 'user' }, JWT_SECRET);
    mockFindOne.mockResolvedValue({ email: 'user@test.com', status: 'disabled', role: 'user' });

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = createMockRes();
    const next = vi.fn();

    await enhancedAuthMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Account is disabled');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user is active', async () => {
    const token = jwt.sign({ email: 'user@test.com', name: 'Test', role: 'user' }, JWT_SECRET);
    mockFindOne.mockResolvedValue({ email: 'user@test.com', status: 'active', role: 'user' });

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = createMockRes();
    const next = vi.fn();

    await enhancedAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.email).toBe('user@test.com');
    expect(req.user.role).toBe('user');
  });

  it('updates role from DB if it changed', async () => {
    const token = jwt.sign({ email: 'user@test.com', name: 'Test', role: 'user' }, JWT_SECRET);
    mockFindOne.mockResolvedValue({ email: 'user@test.com', status: 'active', role: 'admin' });

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = createMockRes();
    const next = vi.fn();

    await enhancedAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('admin');
  });
});

describe('bootstrapSuperAdmin', () => {
  const originalEnv = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_PASSWORD = originalEnv;
    } else {
      delete process.env.ADMIN_PASSWORD;
    }
  });

  it('skips bootstrap when ADMIN_PASSWORD is not set', async () => {
    delete process.env.ADMIN_PASSWORD;
    await bootstrapSuperAdmin();
    expect(mockCollection).not.toHaveBeenCalled();
  });

  it('creates admin user when not present', async () => {
    process.env.ADMIN_PASSWORD = 'TestPassword123!';
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({ insertedId: 'test-id' });
    mockCreateIndex.mockResolvedValue('ok');

    await bootstrapSuperAdmin();

    expect(mockInsertOne).toHaveBeenCalled();
    const insertedDoc = mockInsertOne.mock.calls[0][0];
    expect(insertedDoc.email).toBe('admin@capillarytech.com');
    expect(insertedDoc.name).toBe('Admin');
    expect(insertedDoc.role).toBe('admin');
    expect(insertedDoc.status).toBe('active');
    expect(insertedDoc.authProvider).toBe('password');
    expect(insertedDoc.passwordHash).toBeDefined();

    // Verify password hash is valid
    const isValid = await bcrypt.compare('TestPassword123!', insertedDoc.passwordHash);
    expect(isValid).toBe(true);
  });

  it('does not recreate admin if already present', async () => {
    process.env.ADMIN_PASSWORD = 'TestPassword123!';
    mockFindOne.mockResolvedValue({
      email: 'admin@capillarytech.com',
      role: 'admin',
      passwordHash: await bcrypt.hash('TestPassword123!', 10)
    });
    mockCreateIndex.mockResolvedValue('ok');

    await bootstrapSuperAdmin();

    expect(mockInsertOne).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
