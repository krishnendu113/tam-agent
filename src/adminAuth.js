// Admin authentication module - password-based login, admin middleware, enhanced auth middleware.

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from './db.js';
import { isLocked, recordFailedAttempt, resetLockout } from './lockout.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const LOCKOUT_DURATION_SECONDS = 900; // 15 minutes

/**
 * Express route handler: POST /api/auth/admin-login
 * Validates email/password against bcrypt hash in users collection.
 * Checks lockout status and user disabled status.
 * Issues JWT with { email, name, role } payload on success.
 */
export async function adminLoginHandler(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    // Check lockout status
    if (isLocked(email)) {
      return res.status(423).json({
        error: 'Account locked',
        retryAfter: LOCKOUT_DURATION_SECONDS
      });
    }

    const db = getDb();
    const usersCollection = db.collection('users');

    // Find user by email
    const user = await usersCollection.findOne({ email });

    if (!user || !user.passwordHash) {
      // Record failed attempt even if user not found (prevent enumeration)
      recordFailedAttempt(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if account is disabled
    if (user.status === 'disabled') {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    // Verify password against bcrypt hash
    const passwordValid = await bcrypt.compare(password, user.passwordHash);

    if (!passwordValid) {
      const lockoutResult = recordFailedAttempt(email);
      if (lockoutResult.locked) {
        return res.status(423).json({
          error: 'Account locked',
          retryAfter: LOCKOUT_DURATION_SECONDS
        });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Successful login - reset lockout
    resetLockout(email);

    // Update lastLoginAt
    await usersCollection.updateOne(
      { email },
      { $set: { lastLoginAt: new Date(), updatedAt: new Date() } }
    );

    // Issue JWT with email, name, role
    const token = jwt.sign(
      {
        email: user.email,
        name: user.name,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    return res.status(200).json({
      token,
      user: { email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    console.error('[adminAuth] Login error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Express middleware: adminMiddleware
 * Verifies that req.user.role === 'admin'. Returns 403 if not.
 * Must be used after authMiddleware (which sets req.user).
 */
export function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Enhanced Express middleware: enhancedAuthMiddleware
 * After JWT verification, looks up user in users collection and checks status !== 'disabled'.
 * Returns 403 if user is disabled.
 */
export async function enhancedAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Look up user in database and check status
    const db = getDb();
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email: decoded.email });

    if (user && user.status === 'disabled') {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    // Attach the role from DB if available (in case it changed since token was issued)
    if (user) {
      req.user.role = user.role;
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Bootstraps the super admin user record on server start.
 * Upserts admin@capillarytech.com with role "admin" and bcrypt-hashed password
 * from ADMIN_PASSWORD env var, if not already present.
 */
export async function bootstrapSuperAdmin() {
  const adminEmail = 'admin@capillarytech.com';
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.warn('[adminAuth] ADMIN_PASSWORD env var not set. Skipping super admin bootstrap.');
    return;
  }

  try {
    const db = getDb();
    const usersCollection = db.collection('users');

    const existingAdmin = await usersCollection.findOne({ email: adminEmail });

    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await usersCollection.insertOne({
        email: adminEmail,
        name: 'Admin',
        role: 'admin',
        status: 'active',
        passwordHash,
        authProvider: 'password',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log('[adminAuth] Super admin user bootstrapped.');
    } else {
      // Ensure existing admin has the correct role and a password hash
      const updates = {};
      if (existingAdmin.role !== 'admin') {
        updates.role = 'admin';
      }
      if (!existingAdmin.passwordHash) {
        updates.passwordHash = await bcrypt.hash(adminPassword, 10);
      }
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date();
        await usersCollection.updateOne({ email: adminEmail }, { $set: updates });
        console.log('[adminAuth] Super admin user updated.');
      }
    }

    // Create indexes for users collection
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await usersCollection.createIndex({ role: 1, status: 1 });
  } catch (err) {
    console.error('[adminAuth] Failed to bootstrap super admin:', err.message);
  }
}

export default {
  adminLoginHandler,
  adminMiddleware,
  enhancedAuthMiddleware,
  bootstrapSuperAdmin
};
