/**
 * Property-based tests for public/js/nav.js - Navigation module
 * Property 11: Navigation renders correctly based on user role
 *
 * Feature: frontend-auth-admin, Property 11: Navigation renders correctly based on user role
 * Validates: Requirements 5.2, 5.4
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';
import fc from 'fast-check';

// Load the nav.js source
const navJsPath = resolve(process.cwd(), 'public/js/nav.js');
const navJsSource = readFileSync(navJsPath, 'utf-8');

/**
 * Set up a vm context with nav.js loaded and auth mocks injected.
 * Returns the rendered HTML after calling renderNav.
 *
 * @param {object} opts - Options for the mock context
 * @param {string} opts.role - The user's role ("admin" or "user")
 * @param {string} opts.name - The user's display name
 * @param {string} opts.email - The user's email
 * @returns {string} The rendered navigation HTML
 */
function renderNavForUser({ role, name, email }) {
  let containerHtml = '';

  const context = {
    isAuthenticated: () => true,
    isAdmin: () => role === 'admin',
    getCurrentUser: () => ({ name, email, role }),
    clearToken: () => {},

    document: {
      getElementById(id) {
        if (id === 'navbar') {
          return {
            set innerHTML(html) { containerHtml = html; },
            get innerHTML() { return containerHtml; },
            querySelector() { return null; }
          };
        }
        return null;
      },
      createElement(tag) {
        return {
          innerHTML: '',
          textContent: '',
          appendChild(child) {
            if (child && child.textContent !== undefined) {
              this.innerHTML = child.textContent
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            }
            return child;
          }
        };
      },
      createTextNode(text) {
        return { textContent: text };
      }
    },

    window: { location: { href: '' } },
    console
  };

  vm.createContext(context);
  vm.runInContext(navJsSource, context);
  context.renderNav('navbar');

  return containerHtml;
}

/**
 * Arbitrary for non-empty user names (printable strings, 1-100 chars).
 * Excludes strings that are empty after trimming.
 */
const arbUserName = fc.string({ minLength: 1, maxLength: 100 })
  .filter(s => s.trim().length > 0);

/**
 * Arbitrary for email addresses (simplified but realistic).
 */
const arbEmail = fc.tuple(
  fc.stringMatching(/^[a-z][a-z0-9._]{0,19}$/),
  fc.stringMatching(/^[a-z][a-z0-9]{0,9}\.[a-z]{2,4}$/)
).map(([local, domain]) => `${local}@${domain}`);

/**
 * Arbitrary for user role - either "admin" or "user".
 */
const arbRole = fc.constantFrom('admin', 'user');

describe('Property 11: Navigation renders correctly based on user role', { timeout: 30000 }, () => {
  /**
   * **Validates: Requirements 5.2, 5.4**
   *
   * Property 11: For any authenticated user, the navigation bar SHALL display
   * the user's name or email, and SHALL display the User Management link if
   * and only if the user's role is "admin".
   */
  it('should display User Management link if and only if role is admin, and always show user name or email', () => {
    fc.assert(
      fc.property(
        arbUserName,
        arbEmail,
        arbRole,
        (name, email, role) => {
          const html = renderNavForUser({ role, name, email });

          // The nav must display the user's name or email
          // nav.js uses name if available, falls back to email
          const escapedName = name
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          const escapedEmail = email
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

          // Requirement 5.4: Navigation bar SHALL display the logged-in user's name or email
          const containsNameOrEmail = html.includes(escapedName) || html.includes(escapedEmail);
          expect(containsNameOrEmail).toBe(true);

          // Requirement 5.2: Navigation bar SHALL display User Management link
          // if and only if the user's role is "admin"
          const containsUserManagement = html.includes('User Management');

          if (role === 'admin') {
            expect(containsUserManagement).toBe(true);
          } else {
            expect(containsUserManagement).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
