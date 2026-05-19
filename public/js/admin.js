/**
 * Admin User Management Module
 * Handles the User Management page: fetching users, rendering the table,
 * and performing enable/disable and promote/demote actions with optimistic UI.
 *
 * Dependencies: auth.js (requireAuth, requireAdmin, getCurrentUser),
 *               api.js (apiGet, apiPatch),
 *               nav.js (renderNav)
 */

/* global requireAuth, requireAdmin, getCurrentUser, apiGet, apiPatch, renderNav */

/**
 * Format a date string as a relative timestamp.
 * Returns "Never" for null/undefined, "just now" for <1min, "Xm ago", "Xh ago", "Xd ago".
 * @param {string|null} dateStr - ISO date string or null
 * @returns {string}
 */
function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Never';

  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return diffMinutes + 'm ago';
  if (diffHours < 24) return diffHours + 'h ago';
  return diffDays + 'd ago';
}

/**
 * Show a toast notification message.
 * @param {string} message - The message to display
 * @param {'success'|'error'|'warning'} type - The toast type
 */
function showToast(message, type) {
  var container = document.getElementById('toast-container');
  if (!container) return;

  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.setAttribute('role', 'alert');
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(function () {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 3000);
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtmlAdmin(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str || ''));
  return div.innerHTML;
}

/**
 * Render a single user table row.
 * @param {object} user - The user object from the API
 * @param {string} currentUserEmail - The logged-in admin's email
 * @returns {string} HTML string for the table row
 */
function renderUserRow(user, currentUserEmail) {
  var isSelf = user.email === currentUserEmail;

  var roleBadgeClass = user.role === 'admin' ? 'badge-admin' : 'badge-user';
  var statusBadgeClass = user.status === 'active' ? 'badge-active' : 'badge-disabled';

  var statusBtn = '';
  var roleBtn = '';

  if (!isSelf) {
    if (user.status === 'active') {
      statusBtn = '<button class="btn-sm btn-danger" data-action="disable" data-user-id="' +
        escapeHtmlAdmin(user._id) + '">Disable</button>';
    } else {
      statusBtn = '<button class="btn-sm btn-success" data-action="enable" data-user-id="' +
        escapeHtmlAdmin(user._id) + '">Enable</button>';
    }

    if (user.role === 'user') {
      roleBtn = '<button class="btn-sm btn-secondary" data-action="promote" data-user-id="' +
        escapeHtmlAdmin(user._id) + '">Promote to Admin</button>';
    } else {
      roleBtn = '<button class="btn-sm btn-secondary" data-action="demote" data-user-id="' +
        escapeHtmlAdmin(user._id) + '">Demote to User</button>';
    }
  }

  return '<tr data-user-id="' + escapeHtmlAdmin(user._id) + '">' +
    '<td>' + escapeHtmlAdmin(user.name || '') + '</td>' +
    '<td>' + escapeHtmlAdmin(user.email) + '</td>' +
    '<td><span class="badge ' + roleBadgeClass + '">' + escapeHtmlAdmin(user.role) + '</span></td>' +
    '<td><span class="badge ' + statusBadgeClass + '">' + escapeHtmlAdmin(user.status) + '</span></td>' +
    '<td>' + formatRelativeTime(user.lastLoginAt) + '</td>' +
    '<td>' + statusBtn + ' ' + roleBtn + '</td>' +
    '</tr>';
}

/**
 * Render the full user table.
 * @param {Array} users - Array of user objects
 * @param {string} currentUserEmail - The logged-in admin's email
 */
function renderUsersTable(users, currentUserEmail) {
  var loadingState = document.getElementById('loading-state');
  var emptyState = document.getElementById('empty-state');
  var tableContainer = document.getElementById('table-container');
  var tableBody = document.getElementById('users-table-body');

  if (loadingState) loadingState.classList.add('hidden');

  if (!users || users.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (tableContainer) tableContainer.classList.add('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');
  if (tableContainer) tableContainer.classList.remove('hidden');

  var html = '';
  for (var i = 0; i < users.length; i++) {
    html += renderUserRow(users[i], currentUserEmail);
  }
  if (tableBody) tableBody.innerHTML = html;
}

/** Store the users array in memory for optimistic updates */
var usersData = [];

/**
 * Find a user in the local data by ID.
 * @param {string} userId
 * @returns {object|null}
 */
function findUserById(userId) {
  for (var i = 0; i < usersData.length; i++) {
    if (usersData[i]._id === userId) return usersData[i];
  }
  return null;
}

/**
 * Handle disable/enable action with optimistic UI.
 * @param {string} userId
 * @param {string} newStatus - "disabled" or "active"
 */
async function handleStatusChange(userId, newStatus) {
  var user = findUserById(userId);
  if (!user) return;

  var previousStatus = user.status;
  var currentUser = getCurrentUser();

  // Optimistic update
  user.status = newStatus;
  renderUsersTable(usersData, currentUser.email);

  try {
    var response = await apiPatch('/api/admin/users/' + userId, { status: newStatus });

    if (response.status === 400) {
      var data = await response.json();
      showToast(data.error || 'Cannot modify your own account', 'warning');
      // Rollback
      user.status = previousStatus;
      renderUsersTable(usersData, currentUser.email);
    } else if (!response.ok) {
      // Rollback on any other error
      user.status = previousStatus;
      renderUsersTable(usersData, currentUser.email);
      showToast('Failed to update user status', 'error');
    } else {
      showToast('User status updated to ' + newStatus, 'success');
    }
  } catch (e) {
    // Network error — rollback
    user.status = previousStatus;
    renderUsersTable(usersData, currentUser.email);
    showToast('Connection error. Please try again.', 'error');
  }
}

/**
 * Handle promote/demote action with optimistic UI.
 * @param {string} userId
 * @param {string} newRole - "admin" or "user"
 */
async function handleRoleChange(userId, newRole) {
  var user = findUserById(userId);
  if (!user) return;

  var previousRole = user.role;
  var currentUser = getCurrentUser();

  // Optimistic update
  user.role = newRole;
  renderUsersTable(usersData, currentUser.email);

  try {
    var response = await apiPatch('/api/admin/users/' + userId, { role: newRole });

    if (response.status === 400) {
      var data = await response.json();
      showToast(data.error || 'Cannot modify your own account', 'warning');
      // Rollback
      user.role = previousRole;
      renderUsersTable(usersData, currentUser.email);
    } else if (!response.ok) {
      // Rollback on any other error
      user.role = previousRole;
      renderUsersTable(usersData, currentUser.email);
      showToast('Failed to update user role', 'error');
    } else {
      showToast('User role updated to ' + newRole, 'success');
    }
  } catch (e) {
    // Network error — rollback
    user.role = previousRole;
    renderUsersTable(usersData, currentUser.email);
    showToast('Connection error. Please try again.', 'error');
  }
}

/**
 * Handle click events on the table body (event delegation).
 * @param {Event} event
 */
function handleTableClick(event) {
  var target = event.target;
  if (target.tagName !== 'BUTTON') return;

  var action = target.getAttribute('data-action');
  var userId = target.getAttribute('data-user-id');
  if (!action || !userId) return;

  switch (action) {
    case 'disable':
      handleStatusChange(userId, 'disabled');
      break;
    case 'enable':
      handleStatusChange(userId, 'active');
      break;
    case 'promote':
      handleRoleChange(userId, 'admin');
      break;
    case 'demote':
      handleRoleChange(userId, 'user');
      break;
  }
}

/**
 * Fetch users from the API and render the table.
 */
async function loadUsers() {
  var currentUser = getCurrentUser();
  if (!currentUser) return;

  try {
    var response = await apiGet('/api/admin/users');

    if (!response.ok) {
      var loadingState = document.getElementById('loading-state');
      if (loadingState) loadingState.classList.add('hidden');
      showToast('Failed to load users', 'error');
      return;
    }

    usersData = await response.json();
    renderUsersTable(usersData, currentUser.email);
  } catch (e) {
    var loadingEl = document.getElementById('loading-state');
    if (loadingEl) loadingEl.classList.add('hidden');
    showToast('Connection error. Please try again.', 'error');
  }
}

/**
 * Initialize the admin page on load.
 */
function initAdmin() {
  // Auth guards
  requireAuth();
  requireAdmin();

  // Render navigation
  renderNav('navbar');

  // Set up event delegation for table actions
  var tableBody = document.getElementById('users-table-body');
  if (tableBody) {
    tableBody.addEventListener('click', handleTableClick);
  }

  // Load users
  loadUsers();
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', initAdmin);
