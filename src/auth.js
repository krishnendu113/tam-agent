// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Authentication module - handles user authentication and session management.

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

/**
 * Authenticates a user with email and password.
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {object} db - Database instance
 * @returns {Promise<object>} Authentication result with token
 */
export async function authenticate(email, password, db) {
  const user = await db.collection('users').findOne({ email });
  if (!user) {
    throw new Error('Invalid credentials');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, {
    expiresIn: JWT_EXPIRY
  });

  return { token, user: { id: user._id, email: user.email, name: user.name } };
}

/**
 * Verifies a JWT token.
 * @param {string} token - JWT token to verify
 * @returns {object} Decoded token payload
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Hashes a password for storage.
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

/**
 * Express middleware for authentication.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Next middleware
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.slice(7);
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export default { authenticate, verifyToken, hashPassword, authMiddleware };
