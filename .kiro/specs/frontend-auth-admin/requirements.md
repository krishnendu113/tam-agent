# Requirements Document

## Introduction

This feature adds a complete frontend to the TAM Agent application, which currently has a working backend (Express + AWS Bedrock LLM + MongoDB) but only a minimal placeholder HTML page. The frontend provides Google OAuth authentication for regular users, password-based authentication for the super admin, a chat interface with conversation history, and an admin user management panel. All pages are built with plain HTML/CSS/JS (no framework, no build step) and served from the `public/` directory via Express static middleware.

## Glossary

- **TAM_Agent_Frontend**: The set of HTML, CSS, and JavaScript files served from the `public/` directory that provide the user interface for the TAM Agent application
- **Auth_Module**: The backend authentication system (`src/auth.js`) that handles Google OAuth, JWT token issuance, and token verification
- **Login_Page**: The HTML page that presents Google OAuth and admin password login options
- **Chat_Page**: The authenticated HTML page that displays the chat interface with conversation sidebar and streaming message area
- **About_Page**: The publicly accessible HTML page that describes the TAM Agent application
- **User_Management_Page**: The admin-only HTML page for managing user accounts
- **Navigation_Bar**: The shared UI component displayed across all pages providing links to application sections
- **Conversation_Sidebar**: The left panel on the Chat_Page that lists the logged-in user's past conversations
- **Super_Admin**: The user with email `admin@capillarytech.com` who has elevated privileges including user management and password-based login
- **Regular_User**: A user who authenticates via Google OAuth with an email domain matching the ALLOWED_DOMAINS environment variable
- **JWT_Token**: A JSON Web Token issued by the Auth_Module upon successful authentication, stored in the browser and sent with API requests
- **Conversation**: A MongoDB document in the `conversations` collection containing an id, userId, title, messages array, createdAt, and updatedAt fields
- **User_Record**: A MongoDB document in the `users` collection containing user profile, role, status, and login metadata
- **SSE_Stream**: A Server-Sent Events connection used by the chat endpoint to stream LLM responses token-by-token to the frontend

## Requirements

### Requirement 1: Google OAuth Login

**User Story:** As a regular user, I want to log in using my Google account, so that I can access the TAM Agent chat without managing a separate password.

#### Acceptance Criteria

1. WHEN the user clicks the Google OAuth button on the Login_Page, THE TAM_Agent_Frontend SHALL redirect the user to the Google OAuth consent screen via the `/auth/google` endpoint
2. WHEN the Google OAuth callback returns a JWT_Token in the URL hash, THE TAM_Agent_Frontend SHALL extract the token and store it in browser localStorage
3. WHEN the JWT_Token is successfully stored, THE TAM_Agent_Frontend SHALL redirect the user to the Chat_Page
4. IF the Google OAuth callback returns an error parameter, THEN THE TAM_Agent_Frontend SHALL display the error message on the Login_Page

### Requirement 2: Admin Password Login

**User Story:** As the super admin, I want to log in using email and password, so that I can access the system without depending on Google OAuth.

#### Acceptance Criteria

1. THE Login_Page SHALL display an email input field and a password input field for admin authentication
2. WHEN the admin submits valid credentials (email: `admin@capillarytech.com` with correct password), THE Auth_Module SHALL verify the password against the bcrypt-hashed value stored in the `users` collection and return a JWT_Token
3. IF the submitted credentials are invalid, THEN THE Auth_Module SHALL return a 401 status and THE TAM_Agent_Frontend SHALL display an "Invalid credentials" error message
4. IF the admin account is locked due to excessive failed attempts, THEN THE Auth_Module SHALL return a 423 status and THE TAM_Agent_Frontend SHALL display a lockout message with remaining duration
5. WHEN the admin login succeeds, THE TAM_Agent_Frontend SHALL store the JWT_Token in localStorage and redirect to the Chat_Page

### Requirement 3: Authentication Enforcement

**User Story:** As a system operator, I want unauthenticated users to be redirected to the login page, so that only authorized users can access the chat.

#### Acceptance Criteria

1. WHEN a user navigates to the Chat_Page without a valid JWT_Token in localStorage, THE TAM_Agent_Frontend SHALL redirect the user to the Login_Page
2. WHEN a user navigates to the User_Management_Page without a valid JWT_Token in localStorage, THE TAM_Agent_Frontend SHALL redirect the user to the Login_Page
3. THE About_Page SHALL be accessible without authentication
4. WHEN the JWT_Token expires or becomes invalid, THE TAM_Agent_Frontend SHALL clear the token from localStorage and redirect the user to the Login_Page

### Requirement 4: Logout

**User Story:** As a logged-in user, I want to log out of the application, so that my session is terminated and my account is secured.

#### Acceptance Criteria

1. WHEN the user clicks the Logout link in the Navigation_Bar, THE TAM_Agent_Frontend SHALL remove the JWT_Token from localStorage
2. WHEN the JWT_Token is removed, THE TAM_Agent_Frontend SHALL redirect the user to the Login_Page

### Requirement 5: Navigation Bar

**User Story:** As a user, I want a consistent navigation bar across all pages, so that I can easily move between sections of the application.

#### Acceptance Criteria

1. THE Navigation_Bar SHALL display links to Chat_Page, About_Page, and a Logout action on all authenticated pages
2. WHILE the logged-in user has the admin role, THE Navigation_Bar SHALL display an additional link to the User_Management_Page
3. THE Login_Page SHALL display a link to the About_Page in its navigation area
4. THE Navigation_Bar SHALL display the logged-in user's name or email

### Requirement 6: Chat Interface with Streaming Responses

**User Story:** As a logged-in user, I want to send messages and receive streaming responses from the TAM Agent, so that I can interact with the AI assistant in real time.

#### Acceptance Criteria

1. THE Chat_Page SHALL display a text input area and a send button for composing messages
2. WHEN the user submits a message, THE TAM_Agent_Frontend SHALL send a POST request to `/api/chat` with the JWT_Token in the Authorization header and the message in the request body
3. WHILE the SSE_Stream is active, THE TAM_Agent_Frontend SHALL append each received token to the assistant message area in real time
4. WHEN the SSE_Stream emits a `complete` event, THE TAM_Agent_Frontend SHALL mark the assistant response as finished and re-enable the input area
5. IF the SSE_Stream emits an `error` event, THEN THE TAM_Agent_Frontend SHALL display the error message to the user and re-enable the input area
6. WHILE a response is streaming, THE TAM_Agent_Frontend SHALL disable the send button to prevent concurrent requests

### Requirement 7: Conversation History Storage

**User Story:** As a logged-in user, I want my conversations to be saved, so that I can return to previous discussions later.

#### Acceptance Criteria

1. WHEN a user sends the first message in a new conversation, THE Auth_Module SHALL create a new Conversation document in the `conversations` collection with the userId, an auto-generated title derived from the first message content, and a createdAt timestamp
2. WHEN a message exchange completes, THE Auth_Module SHALL append both the user message and assistant response to the Conversation messages array and update the updatedAt timestamp
3. THE Conversation document SHALL store each message with a role field (user or assistant) and a content field

### Requirement 8: Conversation Sidebar

**User Story:** As a logged-in user, I want to see a list of my past conversations, so that I can resume any previous discussion.

#### Acceptance Criteria

1. THE Conversation_Sidebar SHALL display a list of the logged-in user's conversations sorted by updatedAt in descending order (most recent first)
2. THE Conversation_Sidebar SHALL display the title and a relative timestamp for each conversation entry
3. WHEN the user clicks a conversation entry in the Conversation_Sidebar, THE TAM_Agent_Frontend SHALL load and display all messages from that Conversation in the chat area
4. THE Conversation_Sidebar SHALL display a "New Conversation" button at the top
5. WHEN the user clicks the "New Conversation" button, THE TAM_Agent_Frontend SHALL clear the chat area and start a new conversation context

### Requirement 9: Conversation Management API

**User Story:** As a logged-in user, I want API endpoints to manage my conversations, so that the frontend can list, load, and create conversations.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/conversations` with a valid JWT_Token, THE Auth_Module SHALL return a list of conversations belonging to the authenticated user, sorted by updatedAt descending
2. WHEN a GET request is made to `/api/conversations/:id` with a valid JWT_Token, THE Auth_Module SHALL return the full conversation document including all messages, provided the conversation belongs to the authenticated user
3. IF a user requests a conversation that does not belong to them, THEN THE Auth_Module SHALL return a 403 status
4. IF a user requests a conversation that does not exist, THEN THE Auth_Module SHALL return a 404 status

### Requirement 10: User Record Management

**User Story:** As a system operator, I want user records to be created and maintained automatically, so that the admin can manage who has access.

#### Acceptance Criteria

1. WHEN a user successfully authenticates for the first time (via Google OAuth or admin login), THE Auth_Module SHALL create a User_Record in the `users` collection with name, email, role (defaulting to "user"), status (defaulting to "active"), and createdAt timestamp
2. WHEN a user successfully authenticates, THE Auth_Module SHALL update the lastLoginAt field on the User_Record
3. THE Super_Admin User_Record SHALL be bootstrapped with role "admin" and email `admin@capillarytech.com` if it does not already exist when the server starts

### Requirement 11: User Management Page

**User Story:** As the super admin, I want to view and manage all users, so that I can control access to the TAM Agent.

#### Acceptance Criteria

1. WHEN the admin navigates to the User_Management_Page, THE TAM_Agent_Frontend SHALL display a table of all User_Records showing name, email, role, lastLoginAt, and status
2. WHEN the admin clicks "Disable" on an active user, THE TAM_Agent_Frontend SHALL send a request to update the user's status to "disabled" and THE Auth_Module SHALL persist the change
3. WHEN the admin clicks "Enable" on a disabled user, THE TAM_Agent_Frontend SHALL send a request to update the user's status to "active" and THE Auth_Module SHALL persist the change
4. WHEN the admin clicks "Promote to Admin" on a regular user, THE TAM_Agent_Frontend SHALL send a request to update the user's role to "admin" and THE Auth_Module SHALL persist the change
5. WHEN the admin clicks "Demote to User" on an admin user, THE TAM_Agent_Frontend SHALL send a request to update the user's role to "user" and THE Auth_Module SHALL persist the change
6. THE User_Management_Page SHALL prevent the Super_Admin from disabling or demoting their own account

### Requirement 12: Disabled User Access Prevention

**User Story:** As a system operator, I want disabled users to be blocked from logging in, so that revoked access is enforced immediately.

#### Acceptance Criteria

1. WHEN a disabled user attempts to authenticate via Google OAuth, THE Auth_Module SHALL reject the login and return an error indicating the account is disabled
2. WHEN a disabled user attempts to authenticate via admin password login, THE Auth_Module SHALL reject the login and return an error indicating the account is disabled
3. IF a disabled user's JWT_Token is presented to a protected endpoint, THEN THE Auth_Module SHALL return a 403 status with a message indicating the account is disabled

### Requirement 13: User Management API

**User Story:** As the super admin, I want API endpoints for user management, so that the frontend can list and modify user accounts.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/admin/users` with a valid admin JWT_Token, THE Auth_Module SHALL return a list of all User_Records
2. WHEN a PATCH request is made to `/api/admin/users/:id` with a valid admin JWT_Token and a body containing status or role updates, THE Auth_Module SHALL update the specified User_Record
3. IF a non-admin user requests `/api/admin/users`, THEN THE Auth_Module SHALL return a 403 status
4. IF a PATCH request attempts to modify the Super_Admin's own role or status, THEN THE Auth_Module SHALL return a 400 status with an error message

### Requirement 14: Admin Login API Endpoint

**User Story:** As the super admin, I want a dedicated login endpoint, so that the frontend can authenticate using email and password.

#### Acceptance Criteria

1. WHEN a POST request is made to `/api/auth/admin-login` with a valid email and password, THE Auth_Module SHALL verify the credentials against the bcrypt-hashed password in the `users` collection and return a JWT_Token
2. IF the email does not match an admin User_Record, THEN THE Auth_Module SHALL return a 401 status with a generic "Invalid credentials" message
3. IF the password does not match the stored hash, THEN THE Auth_Module SHALL return a 401 status with a generic "Invalid credentials" message
4. WHEN admin login succeeds, THE Auth_Module SHALL include the user's role in the JWT_Token payload

### Requirement 15: Responsive and Accessible UI

**User Story:** As a user, I want the interface to work well on mobile devices and be accessible, so that I can use the TAM Agent from any device.

#### Acceptance Criteria

1. THE TAM_Agent_Frontend SHALL use responsive CSS that adapts layout for viewport widths below 768px
2. WHILE the viewport width is below 768px, THE Conversation_Sidebar SHALL be collapsible via a toggle button
3. THE TAM_Agent_Frontend SHALL use semantic HTML elements and ARIA attributes for screen reader compatibility
4. THE TAM_Agent_Frontend SHALL maintain a minimum color contrast ratio of 4.5:1 for all text content

### Requirement 16: About Page

**User Story:** As a visitor, I want to learn about the TAM Agent without logging in, so that I can understand what the application does before creating an account.

#### Acceptance Criteria

1. THE About_Page SHALL be accessible at the `/about.html` path without authentication
2. THE About_Page SHALL describe the TAM Agent's purpose, capabilities, and intended audience
3. THE About_Page SHALL display a link to the Login_Page for unauthenticated visitors
4. WHILE the user is authenticated, THE About_Page SHALL display the full Navigation_Bar with all authenticated links
