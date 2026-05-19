# Implementation Plan: Frontend Auth & Admin

## Overview

This plan implements the full frontend application and supporting backend APIs for the TAM Agent. Backend APIs are built first (testable independently), followed by frontend pages that consume them, and finally integration/property tests. The implementation uses plain HTML/CSS/JS for the frontend and Express/MongoDB for the backend.

## Tasks

- [x] 1. Backend: Admin login and enhanced auth middleware
  - [x] 1.1 Create admin login endpoint and enhanced auth middleware
    - Create `src/adminAuth.js` module with:
      - `POST /api/auth/admin-login` route handler: validate email/password against bcrypt hash in `users` collection, check lockout status via existing `src/lockout.js`, check user status !== disabled, issue JWT with `{ email, name, role }` payload
      - `adminMiddleware` function: verify `req.user.role === 'admin'`, return 403 if not
      - Enhanced `authMiddleware`: after JWT verification, look up user in `users` collection and check `status !== 'disabled'`, return 403 if disabled
    - Bootstrap super admin user record on server start: upsert `admin@capillarytech.com` with role "admin", bcrypt-hashed password from `ADMIN_PASSWORD` env var, if not already present
    - Register the `/api/auth/admin-login` route in `src/server.js`
    - _Requirements: 2.2, 2.3, 2.4, 10.3, 12.3, 14.1, 14.2, 14.3, 14.4_

  - [x] 1.2 Update Google OAuth callback to create/update user records and check disabled status
    - Modify `handleGoogleCallback` in `src/auth.js` to:
      - Upsert user record in `users` collection (name, email, picture, role default "user", status default "active", authProvider "google", lastLoginAt, createdAt)
      - Check if user status is "disabled" — if so, throw error "Account is disabled"
      - Include `role` in the JWT payload
    - _Requirements: 10.1, 10.2, 12.1_

  - [x] 1.3 Write property tests for admin login (Properties 2, 3)
    - **Property 2: Valid admin credentials produce a JWT with correct role**
    - **Property 3: Invalid credentials are always rejected**
    - Create `src/__tests__/adminLogin.property.test.js`
    - **Validates: Requirements 2.2, 2.3, 14.1, 14.2, 14.3, 14.4**

- [x] 2. Backend: Conversations API
  - [x] 2.1 Create conversations routes module
    - Create `src/conversations.js` with:
      - `GET /api/conversations` — query `conversations` collection where `userId` matches `req.user.email`, project `_id, title, updatedAt, createdAt` (exclude messages), sort by `updatedAt` descending
      - `GET /api/conversations/:id` — find conversation by `_id`, verify `userId === req.user.email` (return 403 if mismatch, 404 if not found), return full document with messages
    - Register routes in `src/server.js` behind `authMiddleware`
    - Create MongoDB indexes: `{ userId: 1, updatedAt: -1 }` on `conversations` collection
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 2.2 Enhance `/api/chat` endpoint for conversation persistence
    - Modify the `/api/chat` handler in `src/server.js` to:
      - If `conversationId` is null/missing, create a new conversation document with `userId` from `req.user.email`, auto-generated title (first 50 chars of first user message), `createdAt` timestamp
      - On SSE `complete`, append user message and assistant response to the conversation's `messages` array, update `updatedAt`
      - Return `conversationId` in the SSE `complete` event data
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 2.3 Write property tests for conversations (Properties 5, 9, 10)
    - **Property 5: Conversation ownership isolation**
    - **Property 9: Conversation message persistence preserves structure**
    - **Property 10: Conversation list is sorted by updatedAt descending**
    - Create `src/__tests__/conversations.property.test.js`
    - **Validates: Requirements 7.1, 7.2, 7.3, 8.1, 9.1, 9.2, 9.3**

- [x] 3. Backend: User management API
  - [x] 3.1 Create admin user management routes
    - Create `src/adminRoutes.js` with:
      - `GET /api/admin/users` — return all documents from `users` collection (name, email, role, status, lastLoginAt, createdAt)
      - `PATCH /api/admin/users/:id` — accept `{ status }` or `{ role }` in body, validate that the target user is not the requesting admin's own account (return 400), update the user record, return updated user
    - Register routes in `src/server.js` behind `authMiddleware` + `adminMiddleware`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 11.6_

  - [x] 3.2 Write property tests for user management (Properties 6, 7, 8, 12)
    - **Property 6: User status enable/disable round-trip**
    - **Property 7: User role promote/demote round-trip**
    - **Property 8: Disabled users are blocked on all access paths**
    - **Property 12: Admin endpoint role-based access control**
    - Create `src/__tests__/userManagement.property.test.js`
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3, 13.1, 13.3**

- [x] 4. Checkpoint - Backend APIs complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Frontend: Shared CSS and JavaScript modules
  - [x] 5.1 Create shared CSS design system
    - Create `public/css/styles.css` with:
      - CSS custom properties (color palette, spacing, typography, border-radius) as defined in design
      - Base reset and typography styles
      - Layout utilities (grid, flexbox patterns)
      - Component styles: buttons, forms, cards, navigation bar, toast notifications, sidebar
      - Responsive breakpoint at 768px (sidebar collapse, stack layouts)
      - Accessibility: focus-visible outlines, minimum 4.5:1 contrast ratios
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [x] 5.2 Create client-side auth module (`public/js/auth.js`)
    - Implement:
      - `getToken()`, `setToken(token)`, `clearToken()` — localStorage operations
      - `getCurrentUser()` — decode JWT payload (base64) without verification, return `{ email, name, role, exp }`
      - `isAuthenticated()` — check token exists and not expired
      - `isAdmin()` — check `role === 'admin'` in decoded payload
      - `requireAuth()` — redirect to `/index.html` if not authenticated
      - `requireAdmin()` — redirect to `/chat.html` if not admin
    - _Requirements: 1.2, 3.1, 3.2, 3.4_

  - [x] 5.3 Create API wrapper module (`public/js/api.js`)
    - Implement:
      - `apiGet(url)` — fetch with Authorization header, handle 401 (clear token, redirect)
      - `apiPost(url, body)` — POST with JSON body and auth header
      - `apiPatch(url, body)` — PATCH with JSON body and auth header
      - Global 401 interceptor: clear token, redirect to login
      - Global 403 handling: show disabled account message
    - _Requirements: 3.4, 12.3_

  - [x] 5.4 Create navigation module (`public/js/nav.js`)
    - Implement:
      - `renderNav(containerId)` — inject navigation HTML into placeholder element
      - Show Chat, About, Logout links for all authenticated users
      - Show User Management link only if `isAdmin()` returns true
      - Show user's name or email from decoded token
      - For unauthenticated state (About page): show only About and Login links
      - Logout handler: call `clearToken()`, redirect to login
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 4.1, 4.2_

- [x] 6. Frontend: Login Page
  - [x] 6.1 Create login page (`public/index.html`)
    - Build HTML with:
      - Google OAuth button linking to `/auth/google`
      - Admin login form: email input, password input, submit button
      - Error message display area (inline below form)
      - Link to About page
      - Semantic HTML with ARIA labels
    - Add JavaScript:
      - On page load: check URL hash for `#token=...` (extract and store via `setToken()`, redirect to chat) or `#error=...` (display error)
      - Form submit handler: POST to `/api/auth/admin-login`, handle 200 (store token, redirect), 401 (show error), 423 (show lockout with countdown), 403 (show disabled message)
      - If already authenticated, redirect to chat
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3, 2.4, 2.5, 5.3_

  - [x] 6.2 Write property test for URL hash token extraction (Property 1)
    - **Property 1: URL hash token extraction round-trip**
    - Create `src/__tests__/authGuard.property.test.js`
    - **Validates: Requirements 1.2, 1.4**

- [x] 7. Frontend: Chat Page
  - [x] 7.1 Create chat page (`public/chat.html`)
    - Build HTML with:
      - Navigation bar placeholder
      - Conversation sidebar (left panel): "New Conversation" button, conversation list with titles and timestamps
      - Main chat area: message display area, text input with send button
      - Responsive layout: sidebar collapsible on mobile via toggle button
      - Semantic HTML with ARIA attributes (live region for streaming messages)
    - _Requirements: 6.1, 8.4, 15.2, 15.3_

  - [x] 7.2 Create chat JavaScript module (`public/js/chat.js`)
    - Implement:
      - On page load: call `requireAuth()`, render nav, fetch conversation list from `GET /api/conversations`, populate sidebar
      - Sidebar: render conversations sorted by updatedAt, show title + relative timestamp, click to load conversation
      - "New Conversation" button: clear chat area, reset `currentConversationId` to null
      - Send message: POST to `/api/chat` with `{ conversationId, messages }`, disable send button during streaming
      - SSE handling: listen for `token` events (append to message area), `complete` event (re-enable input, update sidebar), `error` event (show error, re-enable input)
      - Load conversation: GET `/api/conversations/:id`, render all messages in chat area
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 8.1, 8.2, 8.3, 8.5_

  - [x] 7.3 Write unit tests for chat SSE streaming logic
    - Test token concatenation, complete event handling, error recovery
    - **Validates: Requirements 6.3, 6.4, 6.5**

- [x] 8. Frontend: About Page
  - [x] 8.1 Create about page (`public/about.html`)
    - Build HTML with:
      - Navigation: full nav if authenticated, login link if not
      - Content: application description, capabilities, intended audience
      - Link to login page for unauthenticated visitors
      - Semantic HTML, accessible structure
    - Add JavaScript: check auth state for nav rendering (no redirect if unauthenticated)
    - _Requirements: 3.3, 16.1, 16.2, 16.3, 16.4_

- [x] 9. Frontend: User Management Page
  - [x] 9.1 Create user management page (`public/admin.html`)
    - Build HTML with:
      - Navigation bar placeholder
      - User table: columns for name, email, role, status, lastLoginAt
      - Action buttons per row: Enable/Disable, Promote/Demote
      - Semantic HTML with ARIA attributes for table accessibility
    - _Requirements: 11.1, 15.3_

  - [x] 9.2 Create admin JavaScript module (`public/js/admin.js`)
    - Implement:
      - On page load: call `requireAuth()`, call `requireAdmin()`, render nav, fetch users from `GET /api/admin/users`
      - Render user table with all fields
      - Disable/Enable button: PATCH `/api/admin/users/:id` with `{ status: "disabled" | "active" }`, optimistic UI update with rollback on failure
      - Promote/Demote button: PATCH `/api/admin/users/:id` with `{ role: "admin" | "user" }`, optimistic UI update with rollback on failure
      - Prevent actions on super admin's own row (hide or disable buttons for `admin@capillarytech.com` when logged in as that user)
      - Handle 400 error (self-modification attempt): show warning toast
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 13.2_

- [x] 10. Checkpoint - All pages and APIs wired together
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Integration and final property tests
  - [x] 11.1 Write property test for auth guard (Property 4)
    - **Property 4: Auth guard blocks all invalid tokens**
    - Add to `src/__tests__/authGuard.property.test.js`
    - **Validates: Requirements 3.1, 3.2, 3.4**

  - [x] 11.2 Write property test for navigation rendering (Property 11)
    - **Property 11: Navigation renders correctly based on user role**
    - Create test verifying nav output based on role
    - **Validates: Requirements 5.2, 5.4**

  - [x] 11.3 Write property test for SSE token streaming (Property 13)
    - **Property 13: SSE token streaming appends all tokens**
    - Test that concatenation of all token events matches final message content
    - **Validates: Requirements 6.3**

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Backend APIs (tasks 1-3) can be tested independently before frontend work begins
- The existing `src/lockout.js` module is reused for admin login lockout logic
- The existing `src/db.js` module provides MongoDB connection via `connectDb()`
- All frontend files are plain HTML/CSS/JS with no build step — served from `public/`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1", "5.2", "5.3", "5.4"] },
    { "id": 2, "tasks": ["1.3", "2.2", "3.2", "6.1"] },
    { "id": 3, "tasks": ["2.3", "6.2", "7.1", "8.1", "9.1"] },
    { "id": 4, "tasks": ["7.2", "9.2"] },
    { "id": 5, "tasks": ["7.3", "11.1", "11.2", "11.3"] }
  ]
}
```
