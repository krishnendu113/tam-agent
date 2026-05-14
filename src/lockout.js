// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Account lockout module - handles failed login attempt tracking and account locking.

const DEFAULT_CONFIG = {
  maxAttempts: 5,
  lockoutDuration: 15 * 60 * 1000, // 15 minutes in ms
  resetAfter: 60 * 60 * 1000 // 1 hour in ms
};

// In-memory store (production uses DB-backed store)
const attempts = new Map();

/**
 * Records a failed login attempt for a user.
 * @param {string} userId - User identifier (email or ID)
 * @param {object} [config] - Lockout configuration overrides
 * @returns {object} Lockout status { locked: boolean, attemptsRemaining: number }
 */
export function recordFailedAttempt(userId, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  let record = attempts.get(userId) || { count: 0, firstAttempt: now, lockedUntil: null };

  // Reset if past reset window
  if (now - record.firstAttempt > cfg.resetAfter) {
    record = { count: 0, firstAttempt: now, lockedUntil: null };
  }

  record.count += 1;
  record.lastAttempt = now;

  if (record.count >= cfg.maxAttempts) {
    record.lockedUntil = now + cfg.lockoutDuration;
  }

  attempts.set(userId, record);

  return {
    locked: record.lockedUntil !== null && now < record.lockedUntil,
    attemptsRemaining: Math.max(0, cfg.maxAttempts - record.count)
  };
}

/**
 * Checks if a user account is currently locked.
 * @param {string} userId - User identifier
 * @returns {boolean} Whether the account is locked
 */
export function isLocked(userId) {
  const record = attempts.get(userId);
  if (!record || !record.lockedUntil) return false;
  if (Date.now() >= record.lockedUntil) {
    attempts.delete(userId);
    return false;
  }
  return true;
}

/**
 * Resets lockout state for a user (e.g., after successful login).
 * @param {string} userId - User identifier
 */
export function resetLockout(userId) {
  attempts.delete(userId);
}

export default { recordFailedAttempt, isLocked, resetLockout };
