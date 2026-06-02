/**
 * Unit tests for public/js/nav.js - Navigation module
 * Tests renderNav behavior for authenticated/unauthenticated states and admin/user roles.
 *
 * Since jsdom is not available, we test the nav module by evaluating it in a
 * minimal DOM mock environment using vm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// Load the nav.js source
const navJsPath = resolve(process.cwd(), 'public/js/nav.js');
const navJsSource = readFileSync(navJsPath, 'utf-8');

/**
 * Create a minimal DOM mock sufficient for nav.js testing.
 */
function createMockDocument() {
  const elements = {};

  function createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      textContent: '',
      innerHTML: '',
      children: [],
      attributes: {},
      eventListeners: {},
      appendChild(child) {
        this.children.push(child);
        if (child.textContent !== undefined) {
          // Simulate text node appending for escapeHtml
          this.innerHTML = child.textContent
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        }
        return child;
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name] || null;
      },
      addEventListener(event, handler) {
        if (!this.eventListeners[event]) {
          this.eventListeners[event] = [];
        }
        this.eventListeners[event].push(handler);
      },
      click() {
        if (this.eventListeners.click) {
          this.eventListeners.click.forEach(h => h());
        }
      },
      querySelector(selector) {
        return findInHtml(this.innerHTML, selector);
      },
      querySelectorAll(selector) {
        return findAllInHtml(this.innerHTML, selector);
      }
    };
    return el;
  }

  function createTextNode(text) {
    return { textContent: text, nodeType: 3 };
  }

  return {
    getElementById(id) {
      return elements[id] || null;
    },
    createElement,
    createTextNode,
    _addElement(id, el) {
      elements[id] = el;
    }
  };
}

/**
 * Set up a vm context with nav.js loaded and auth mocks injected.
 * Returns the context with renderNav and the container element.
 */
function setupContext({ authenticated = false, admin = false, user = null } = {}) {
  // We'll capture the innerHTML set on the container and parse it simply
  let containerHtml = '';
  const clearTokenMock = vi.fn();
  const locationMock = { href: '' };

  const context = {
    // Auth mocks
    isAuthenticated: () => authenticated,
    isAdmin: () => admin,
    getCurrentUser: () => user,
    clearToken: clearTokenMock,

    // Minimal DOM
    document: {
      getElementById(id) {
        if (id === 'navbar') {
          return {
            set innerHTML(html) { containerHtml = html; },
            get innerHTML() { return containerHtml; },
            querySelector(selector) {
              // Simple selector matching for #logout-btn
              if (selector === '#logout-btn') {
                if (containerHtml.includes('id="logout-btn"')) {
                  const btn = {
                    _listeners: {},
                    addEventListener(event, handler) {
                      this._listeners[event] = handler;
                    },
                    click() {
                      if (this._listeners.click) this._listeners.click();
                    }
                  };
                  return btn;
                }
                return null;
              }
              return null;
            }
          };
        }
        return null;
      },
      createElement(tag) {
        return {
          tagName: tag,
          innerHTML: '',
          textContent: '',
          children: [],
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

    window: { location: locationMock },
    console
  };

  // Make window.location accessible as just location in the script
  context.location = locationMock;

  // Run nav.js in the context
  vm.createContext(context);
  vm.runInContext(navJsSource, context);

  return {
    context,
    getHtml: () => containerHtml,
    clearTokenMock,
    locationMock
  };
}

describe('nav.js - renderNav', () => {
  describe('unauthenticated state', () => {
    it('should render About and Login links for unauthenticated users', () => {
      const { context, getHtml } = setupContext({ authenticated: false });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('About');
      expect(html).toContain('Login');
      expect(html).not.toContain('Chat');
      expect(html).not.toContain('Logout');
      expect(html).not.toContain('User Management');
    });

    it('should render brand linking to login page', () => {
      const { context, getHtml } = setupContext({ authenticated: false });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('navbar-brand');
      expect(html).toContain('href="/index.html"');
      expect(html).toContain('TAM Agent');
    });

    it('should include About link pointing to /about.html', () => {
      const { context, getHtml } = setupContext({ authenticated: false });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('href="/about.html"');
    });
  });

  describe('authenticated state - regular user', () => {
    it('should render Chat, About, and Logout links', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John Doe', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('Chat');
      expect(html).toContain('About');
      expect(html).toContain('Logout');
      expect(html).not.toContain('User Management');
    });

    it('should display user name in navbar-user-name', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John Doe', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('navbar-user-name');
      expect(html).toContain('John Doe');
    });

    it('should display email if name is empty', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: '', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('john@example.com');
    });

    it('should NOT show User Management link for regular users', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).not.toContain('User Management');
      expect(html).not.toContain('/admin.html');
    });

    it('should render brand linking to chat page', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('class="navbar-brand"');
      expect(html).toContain('href="/chat.html"');
    });
  });

  describe('authenticated state - admin user', () => {
    it('should show User Management link for admin users', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: true,
        user: { name: 'Admin', email: 'admin@capillarytech.com', role: 'admin' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('User Management');
      expect(html).toContain('href="/admin.html"');
    });

    it('should still show Chat, About, and Logout for admin', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: true,
        user: { name: 'Admin', email: 'admin@capillarytech.com', role: 'admin' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('Chat');
      expect(html).toContain('About');
      expect(html).toContain('Logout');
    });
  });

  describe('logout handler', () => {
    it('should call clearToken and redirect to /index.html on logout click', () => {
      // For this test we need a more complete mock that captures the logout handler
      let logoutHandler = null;
      const clearTokenMock = vi.fn();
      const locationMock = { href: '' };

      const context = {
        isAuthenticated: () => true,
        isAdmin: () => false,
        getCurrentUser: () => ({ name: 'John', email: 'john@example.com', role: 'user' }),
        clearToken: clearTokenMock,
        document: {
          getElementById(id) {
            if (id === 'navbar') {
              return {
                _html: '',
                set innerHTML(html) { this._html = html; },
                get innerHTML() { return this._html; },
                querySelector(selector) {
                  if (selector === '#logout-btn') {
                    return {
                      addEventListener(event, handler) {
                        if (event === 'click') logoutHandler = handler;
                      }
                    };
                  }
                  return null;
                }
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
        window: { location: locationMock },
        console
      };

      vm.createContext(context);
      vm.runInContext(navJsSource, context);

      context.renderNav('navbar');

      expect(logoutHandler).not.toBeNull();
      logoutHandler();

      expect(clearTokenMock).toHaveBeenCalled();
      expect(locationMock.href).toBe('/index.html');
    });
  });

  describe('edge cases', () => {
    it('should handle missing container gracefully (no error thrown)', () => {
      const context = {
        isAuthenticated: () => false,
        isAdmin: () => false,
        getCurrentUser: () => null,
        clearToken: vi.fn(),
        document: {
          getElementById() { return null; },
          createElement(tag) {
            return { innerHTML: '', textContent: '', appendChild(c) { return c; } };
          },
          createTextNode(text) { return { textContent: text }; }
        },
        window: { location: { href: '' } },
        console
      };

      vm.createContext(context);
      vm.runInContext(navJsSource, context);

      // Should not throw
      expect(() => context.renderNav('nonexistent')).not.toThrow();
    });

    it('should escape HTML in user name to prevent XSS', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: '<script>alert("xss")</script>', email: 'xss@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      // Should contain escaped version, not raw script tag
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('should show "User" as fallback when getCurrentUser returns null', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: null
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('User');
    });
  });

  describe('accessibility', () => {
    it('should have role="navigation" on nav element', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('role="navigation"');
    });

    it('should have aria-label="Main navigation" on nav element', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('aria-label="Main navigation"');
    });

    it('should have aria-label on logout button', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: false,
        user: { name: 'John', email: 'john@example.com', role: 'user' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('aria-label="Logout"');
    });

    it('should have aria-label on User Management link for admin', () => {
      const { context, getHtml } = setupContext({
        authenticated: true,
        admin: true,
        user: { name: 'Admin', email: 'admin@capillarytech.com', role: 'admin' }
      });

      context.renderNav('navbar');
      const html = getHtml();

      expect(html).toContain('aria-label="User Management"');
    });
  });
});
