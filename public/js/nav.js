/**
 * Navigation Module
 * Renders the shared navigation bar across all pages.
 * Adapts content based on authentication state and user role.
 *
 * Dependencies: auth.js (isAuthenticated, isAdmin, getCurrentUser, clearToken)
 */

/* global isAuthenticated, isAdmin, getCurrentUser, clearToken */

/**
 * Render the navigation bar into the specified container element.
 * For authenticated users: shows brand, Chat, About, Admin (if admin), user name, Logout.
 * For unauthenticated users: shows brand, About, Login.
 *
 * @param {string} containerId - The ID of the DOM element to inject nav HTML into
 */
function renderNav(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    return;
  }

  const authenticated = isAuthenticated();

  if (authenticated) {
    container.innerHTML = buildAuthenticatedNav();
    attachLogoutHandler(container);
  } else {
    container.innerHTML = buildUnauthenticatedNav();
  }
}

/**
 * Build navigation HTML for authenticated users.
 * Shows Chat, About, User Management (admin only), user name, and Logout.
 *
 * @returns {string} HTML string for the authenticated navigation bar
 */
function buildAuthenticatedNav() {
  const user = getCurrentUser();
  const displayName = (user && (user.name || user.email)) || 'User';
  const adminLink = isAdmin()
    ? '<a href="/admin.html" class="navbar-link" aria-label="User Management">User Management</a>'
    : '';

  return '<nav class="navbar" role="navigation" aria-label="Main navigation">' +
    '<a href="/chat.html" class="navbar-brand">TAM Agent</a>' +
    '<div class="navbar-links">' +
      '<a href="/chat.html" class="navbar-link">Chat</a>' +
      '<a href="/about.html" class="navbar-link">About</a>' +
      adminLink +
    '</div>' +
    '<div class="navbar-user">' +
      '<span class="navbar-user-name">' + escapeHtml(displayName) + '</span>' +
      '<button class="navbar-link" id="logout-btn" type="button" aria-label="Logout">Logout</button>' +
    '</div>' +
  '</nav>';
}

/**
 * Build navigation HTML for unauthenticated users.
 * Shows only About and Login links.
 *
 * @returns {string} HTML string for the unauthenticated navigation bar
 */
function buildUnauthenticatedNav() {
  return '<nav class="navbar" role="navigation" aria-label="Main navigation">' +
    '<a href="/index.html" class="navbar-brand">TAM Agent</a>' +
    '<div class="navbar-links">' +
      '<a href="/about.html" class="navbar-link">About</a>' +
      '<a href="/index.html" class="navbar-link">Login</a>' +
    '</div>' +
  '</nav>';
}

/**
 * Attach the logout click handler to the logout button within the container.
 * Clears the auth token and redirects to the login page.
 *
 * @param {HTMLElement} container - The container element holding the nav
 */
function attachLogoutHandler(container) {
  const logoutBtn = container.querySelector('#logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      clearToken();
      window.location.href = '/index.html';
    });
  }
}

/**
 * Escape HTML special characters to prevent XSS when injecting user-provided text.
 *
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML insertion
 */
function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
