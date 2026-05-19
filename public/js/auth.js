/**
 * Client-side authentication module.
 * Manages JWT token storage, decoding, and page access guards.
 */

const TOKEN_KEY = 'token';

/**
 * Retrieve the stored JWT token from localStorage.
 * @returns {string|null}
 */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Store a JWT token in localStorage.
 * @param {string} token
 */
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Remove the JWT token from localStorage.
 */
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Decode the JWT payload (middle segment) without verification.
 * Returns the decoded payload object or null if the token is invalid.
 * @returns {{ email: string, name: string, role: string, exp: number } | null}
 */
function getCurrentUser() {
  const token = getToken();
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Base64url decode the payload (second segment)
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

/**
 * Check if the user is authenticated (token exists and is not expired).
 * @returns {boolean}
 */
function isAuthenticated() {
  const user = getCurrentUser();
  if (!user) return false;

  // exp is a Unix timestamp in seconds
  const now = Math.floor(Date.now() / 1000);
  return user.exp > now;
}

/**
 * Check if the current user has the admin role.
 * @returns {boolean}
 */
function isAdmin() {
  const user = getCurrentUser();
  if (!user) return false;
  return user.role === 'admin';
}

/**
 * Page guard: redirect to login page if the user is not authenticated.
 * Call on page load for any protected page.
 */
function requireAuth() {
  if (!isAuthenticated()) {
    clearToken();
    window.location.href = '/index.html';
  }
}

/**
 * Page guard: redirect to chat page if the user is not an admin.
 * Call on page load for admin-only pages (after requireAuth).
 */
function requireAdmin() {
  if (!isAdmin()) {
    window.location.href = '/chat.html';
  }
}
