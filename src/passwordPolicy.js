// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Password policy module - enforces password strength requirements.

/**
 * Default password policy configuration.
 */
const DEFAULT_POLICY = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  specialChars: '!@#$%^&*()_+-=[]{}|;:,.<>?'
};

/**
 * Validates a password against the configured policy.
 * @param {string} password - Password to validate
 * @param {object} [policy] - Policy overrides
 * @returns {object} Validation result { valid: boolean, errors: string[] }
 */
export function validatePassword(password, policy = {}) {
  const config = { ...DEFAULT_POLICY, ...policy };
  const errors = [];

  if (!password || password.length < config.minLength) {
    errors.push(`Password must be at least ${config.minLength} characters`);
  }

  if (password && password.length > config.maxLength) {
    errors.push(`Password must be at most ${config.maxLength} characters`);
  }

  if (config.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (config.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (config.requireNumbers && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (config.requireSpecialChars) {
    const hasSpecial = [...password].some(c => config.specialChars.includes(c));
    if (!hasSpecial) {
      errors.push('Password must contain at least one special character');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Returns the current password policy configuration.
 * @returns {object} Policy configuration
 */
export function getPolicy() {
  return { ...DEFAULT_POLICY };
}

export default { validatePassword, getPolicy };
