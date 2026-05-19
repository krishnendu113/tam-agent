// Authentication module - Google OAuth + JWT session management.

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean);

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * Checks if Google OAuth is configured.
 */
function isOAuthConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/**
 * Generates the Google OAuth consent URL.
 */
export function getGoogleAuthURL() {
  if (!isOAuthConfigured()) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent'
  });

  return `${GOOGLE_AUTH_URL}?${params}`;
}

/**
 * Exchanges an authorization code for tokens and user info.
 * @param {string} code - Authorization code from Google callback
 * @returns {Promise<object>} User info and JWT token
 */
export async function handleGoogleCallback(code) {
  if (!isOAuthConfigured()) {
    throw new Error('Google OAuth is not configured.');
  }

  // Exchange code for tokens
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code'
    }).toString()
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const tokens = await tokenResponse.json();

  // Fetch user info
  const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` }
  });

  if (!userInfoResponse.ok) {
    throw new Error('Failed to fetch user info from Google');
  }

  const userInfo = await userInfoResponse.json();

  // Verify email domain
  const emailDomain = userInfo.email.split('@')[1];
  if (ALLOWED_DOMAINS.length > 0 && !ALLOWED_DOMAINS.includes(emailDomain)) {
    throw new Error(`Email domain "${emailDomain}" is not allowed. Allowed domains: ${ALLOWED_DOMAINS.join(', ')}`);
  }

  // Issue JWT session token
  const token = jwt.sign(
    {
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );

  return { token, user: userInfo };
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
 * Express middleware for authentication.
 * Checks for Bearer token in Authorization header.
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

/**
 * Express route handler: GET /auth/google
 * Redirects to Google OAuth consent screen.
 */
export function googleAuthRedirect(req, res) {
  try {
    const url = getGoogleAuthURL();
    res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Express route handler: GET /auth/google/callback
 * Handles the OAuth callback, exchanges code, issues JWT.
 */
export async function googleAuthCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `OAuth error: ${error}` });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const { token, user } = await handleGoogleCallback(code);
    // Redirect to frontend with token in URL hash
    res.redirect(`/#token=${token}`);
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
}

export default { verifyToken, authMiddleware, googleAuthRedirect, googleAuthCallback, getGoogleAuthURL, handleGoogleCallback };
