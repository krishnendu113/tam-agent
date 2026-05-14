// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Audit logger module - records security-relevant events for compliance and debugging.

/**
 * Audit event types.
 */
export const AuditEvents = {
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGOUT: 'logout',
  PASSWORD_CHANGE: 'password_change',
  ACCOUNT_LOCKED: 'account_locked',
  TOKEN_REFRESH: 'token_refresh',
  PERMISSION_DENIED: 'permission_denied',
  DATA_ACCESS: 'data_access',
  DATA_MODIFICATION: 'data_modification'
};

/**
 * Logs an audit event.
 * @param {string} event - Event type from AuditEvents
 * @param {object} details - Event details
 * @param {string} [details.userId] - User who triggered the event
 * @param {string} [details.ip] - IP address
 * @param {object} [details.metadata] - Additional metadata
 */
export function logAuditEvent(event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    userId: details.userId || 'anonymous',
    ip: details.ip || 'unknown',
    metadata: details.metadata || {},
    level: getEventLevel(event)
  };

  // In production, this writes to a dedicated audit collection or external service
  console.log(`[AUDIT] ${JSON.stringify(entry)}`);
  return entry;
}

/**
 * Determines the severity level of an audit event.
 * @param {string} event - Event type
 * @returns {string} Severity level
 */
function getEventLevel(event) {
  const highSeverity = [
    AuditEvents.ACCOUNT_LOCKED,
    AuditEvents.PERMISSION_DENIED,
    AuditEvents.LOGIN_FAILURE
  ];
  return highSeverity.includes(event) ? 'warning' : 'info';
}

/**
 * Creates an audit logger middleware for Express.
 * @returns {function} Express middleware
 */
export function auditMiddleware() {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        logAuditEvent(AuditEvents.PERMISSION_DENIED, {
          userId: req.user?.userId,
          ip: req.ip,
          metadata: { path: req.path, method: req.method, status: res.statusCode }
        });
      }
    });
    next();
  };
}

export default { AuditEvents, logAuditEvent, auditMiddleware };
