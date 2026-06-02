/**
 * Chat Module
 * Handles the chat interface: conversation sidebar, message sending,
 * SSE streaming, phase indicators, dark mode, and conversation loading.
 *
 * Dependencies: auth.js (requireAuth, getToken, getCurrentUser, clearToken),
 *               api.js (apiGet)
 */

/* global requireAuth, getToken, getCurrentUser, clearToken, apiGet, escapeHtml */

/** @type {string|null} */
var currentConversationId = null;

/** @type {Array<{role: string, content: string}>} */
var messages = [];

/** @type {boolean} */
var isStreaming = false;

/** @type {Array<{_id: string, title: string, updatedAt: string}>} */
var allConversations = [];

/**
 * Initialize the chat page on load.
 */
(function init() {
  requireAuth();
  initTheme();
  initUserInfo();
  loadConversationList();
  attachEventListeners();
})();

/**
 * Initialize dark/light theme from localStorage.
 */
function initTheme() {
  try {
    var savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    }
  } catch (e) {
    // localStorage may not be available in test environments
  }
}

/**
 * Toggle dark mode and persist preference.
 */
function toggleTheme() {
  document.body.classList.toggle('dark-mode');
  var isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

/**
 * Populate user info in the sidebar footer.
 */
function initUserInfo() {
  try {
    var user = getCurrentUser();
    var emailEl = document.getElementById('sidebar-user-email');
    if (emailEl && user) {
      emailEl.textContent = user.email || user.name || 'User';
    }
  } catch (e) {
    // getCurrentUser may not be available in test environments
  }
}

/**
 * Attach event listeners for send button, input, sidebar toggle, new conversation, etc.
 */
function attachEventListeners() {
  var sendBtn = document.getElementById('send-btn');
  var chatInput = document.getElementById('chat-input');
  var newConvBtn = document.getElementById('new-conversation-btn');
  var sidebarToggle = document.getElementById('sidebar-toggle');
  var sidebarOverlay = document.getElementById('sidebar-overlay');
  var themeToggle = document.getElementById('theme-toggle');
  var signoutBtn = document.getElementById('sidebar-signout');
  var searchInput = document.getElementById('sidebar-search-input');

  if (sendBtn) {
    sendBtn.addEventListener('click', handleSendMessage);
  }

  if (chatInput) {
    chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });

    // Auto-resize textarea
    chatInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    });
  }

  if (newConvBtn) {
    newConvBtn.addEventListener('click', handleNewConversation);
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', toggleSidebar);
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
  }

  if (signoutBtn) {
    signoutBtn.addEventListener('click', function (e) {
      e.preventDefault();
      clearToken();
      window.location.href = '/index.html';
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', handleSearchConversations);
  }
}

/**
 * Toggle the sidebar open/closed (mobile).
 */
function toggleSidebar() {
  var sidebar = document.getElementById('conversation-sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  var toggle = document.getElementById('sidebar-toggle');

  if (sidebar && overlay) {
    var isOpen = sidebar.classList.toggle('open');
    overlay.classList.toggle('visible');
    if (toggle) {
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
  }
}

/**
 * Close the sidebar (mobile).
 */
function closeSidebar() {
  var sidebar = document.getElementById('conversation-sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  var toggle = document.getElementById('sidebar-toggle');

  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('visible');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}


/**
 * Filter conversations based on search input.
 */
function handleSearchConversations() {
  var searchInput = document.getElementById('sidebar-search-input');
  if (!searchInput) return;

  var query = searchInput.value.trim().toLowerCase();
  if (!query) {
    renderConversationList(allConversations);
    return;
  }

  var filtered = allConversations.filter(function (conv) {
    var title = (conv.title || '').toLowerCase();
    return title.indexOf(query) !== -1;
  });

  renderConversationList(filtered);
}

/**
 * Load the conversation list from the API and render in the sidebar.
 */
async function loadConversationList() {
  try {
    var response = await apiGet('/api/conversations');
    if (!response.ok) return;

    var conversations = await response.json();
    allConversations = conversations;
    renderConversationList(conversations);
  } catch (e) {
    // Network error — silently fail, sidebar stays empty
  }
}

/**
 * Render the conversation list in the sidebar.
 * @param {Array<{_id: string, title: string, updatedAt: string}>} conversations
 */
function renderConversationList(conversations) {
  var listEl = document.getElementById('conversation-list');
  if (!listEl) return;

  if (!conversations || conversations.length === 0) {
    listEl.innerHTML = '<p class="sidebar-empty">No conversations yet</p>';
    return;
  }

  var html = '';
  for (var i = 0; i < conversations.length; i++) {
    var conv = conversations[i];
    var isActive = conv._id === currentConversationId;
    var timestamp = formatRelativeTime(conv.updatedAt);
    var title = conv.title || 'Untitled';

    html += '<button class="sidebar-item' + (isActive ? ' active' : '') + '" ' +
      'data-conversation-id="' + conv._id + '" ' +
      'type="button" ' +
      'aria-label="Load conversation: ' + escapeHtmlAttr(title) + '">' +
      '<span class="sidebar-item-title">' + escapeHtml(title) + '</span>' +
      '<span class="sidebar-item-time">' + timestamp + '</span>' +
      '</button>';
  }

  listEl.innerHTML = html;

  // Attach click handlers to conversation items
  var items = listEl.querySelectorAll('.sidebar-item');
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener('click', handleConversationClick);
  }
}

/**
 * Handle click on a conversation item in the sidebar.
 * @param {Event} e
 */
function handleConversationClick(e) {
  var btn = e.currentTarget;
  var convId = btn.getAttribute('data-conversation-id');
  if (convId) {
    loadConversation(convId);
    closeSidebar();
  }
}

/**
 * Load a specific conversation by ID and render its messages.
 * @param {string} conversationId
 */
async function loadConversation(conversationId) {
  try {
    var response = await apiGet('/api/conversations/' + conversationId);
    if (!response.ok) return;

    var conversation = await response.json();
    currentConversationId = conversation._id;
    messages = conversation.messages || [];
    renderMessages();
    highlightActiveConversation();
  } catch (e) {
    // Network error
  }
}

/**
 * Highlight the active conversation in the sidebar.
 */
function highlightActiveConversation() {
  var listEl = document.getElementById('conversation-list');
  if (!listEl) return;

  var items = listEl.querySelectorAll('.sidebar-item');
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.getAttribute('data-conversation-id') === currentConversationId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  }
}

/**
 * Handle the "New Conversation" button click.
 */
function handleNewConversation() {
  currentConversationId = null;
  messages = [];
  renderMessages();
  highlightActiveConversation();
  hidePhaseBar();

  var chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.focus();
  }
}


/**
 * Handle sending a message.
 */
async function handleSendMessage() {
  if (isStreaming) return;

  var chatInput = document.getElementById('chat-input');
  if (!chatInput) return;

  var content = chatInput.value.trim();
  if (!content) return;

  // Add user message to messages array
  messages.push({ role: 'user', content: content });

  // Clear input and reset height
  chatInput.value = '';
  chatInput.style.height = 'auto';

  // Render messages including the new user message
  renderMessages();

  // Disable input during streaming
  setStreamingState(true);

  // Show phase bar
  showPhaseBar('understanding');

  // Send to API and handle SSE stream
  await sendMessageStream(content);
}

/**
 * Send a message to the chat API and handle the SSE stream response.
 * @param {string} userMessage - The user's message content
 */
async function sendMessageStream(userMessage) {
  var token = getToken();

  try {
    var response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        conversationId: currentConversationId,
        messages: messages.map(function (m) { return { role: m.role, content: m.content }; })
      })
    });

    if (!response.ok) {
      var errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { error: 'Request failed with status ' + response.status };
      }
      showError(errorData.error || 'An error occurred');
      setStreamingState(false);
      hidePhaseBar();
      return;
    }

    // Process the SSE stream
    await processSSEStream(response);
  } catch (e) {
    showError('Connection error. Please try again.');
    setStreamingState(false);
    hidePhaseBar();
  }
}

/**
 * Process the SSE stream from the response body.
 * @param {Response} response
 */
async function processSSEStream(response) {
  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var assistantContent = '';

  // Add an empty assistant message placeholder
  messages.push({ role: 'assistant', content: '' });
  renderMessages();

  try {
    while (true) {
      var result = await reader.read();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });

      // Parse SSE events from buffer
      var lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      var currentEvent = '';
      var currentData = '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if (line.startsWith('event:')) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          currentData = line.substring(5).trim();
        } else if (line === '') {
          // Empty line signals end of an event
          if (currentEvent && currentData) {
            handleSSEEvent(currentEvent, currentData, {
              getContent: function () { return assistantContent; },
              setContent: function (c) { assistantContent = c; }
            });
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }

    // Process any remaining data in buffer
    if (currentEvent && currentData) {
      handleSSEEvent(currentEvent, currentData, {
        getContent: function () { return assistantContent; },
        setContent: function (c) { assistantContent = c; }
      });
    }
  } catch (e) {
    showError('Stream interrupted. Please try again.');
    setStreamingState(false);
    hidePhaseBar();
    removeToolIndicator();
  }

  // Safety: if stream ended without a complete event, re-enable input
  if (isStreaming) {
    setStreamingState(false);
    hidePhaseBar();
    removeToolIndicator();
  }
}

/**
 * Handle a parsed SSE event.
 * @param {string} eventType
 * @param {string} data
 * @param {{getContent: function, setContent: function}} contentRef
 */
function handleSSEEvent(eventType, data, contentRef) {
  switch (eventType) {
    case 'token':
      var tokenData;
      try {
        tokenData = JSON.parse(data);
      } catch (e) {
        tokenData = { text: data };
      }
      // Server sends { text: "..." }, also handle { token: "..." } and { content: "..." }
      var tokenText = tokenData.text || tokenData.token || tokenData.content || '';
      if (!tokenText) break;
      var newContent = contentRef.getContent() + tokenText;
      contentRef.setContent(newContent);

      // Update the last assistant message
      messages[messages.length - 1].content = newContent;
      updateLastAssistantMessage(newContent);
      break;

    case 'phase':
      var phaseData;
      try {
        phaseData = JSON.parse(data);
      } catch (e) {
        phaseData = { phase: data };
      }
      var phase = phaseData.phase || data;
      showPhaseBar(phase);
      break;

    case 'complete':
      var completeData;
      try {
        completeData = JSON.parse(data);
      } catch (e) {
        completeData = {};
      }

      // If the complete event contains the full text and we haven't streamed it yet,
      // display it as the assistant message
      if (completeData.text && contentRef.getContent() === '') {
        contentRef.setContent(completeData.text);
        messages[messages.length - 1].content = completeData.text;
        updateLastAssistantMessage(completeData.text);
      }

      // Update conversationId if provided
      if (completeData.conversationId) {
        var isNewConversation = !currentConversationId;
        currentConversationId = completeData.conversationId;

        // Optimistically add to sidebar immediately for new conversations
        if (isNewConversation) {
          var userMsg = messages.find(function (m) { return m.role === 'user'; });
          var newTitle = userMsg ? userMsg.content.substring(0, 100).trim() : 'New conversation';
          var newConv = {
            _id: completeData.conversationId,
            title: newTitle,
            updatedAt: new Date().toISOString()
          };
          allConversations.unshift(newConv);
          renderConversationList(allConversations);
        }
      }

      setStreamingState(false);
      hidePhaseBar();
      removeToolIndicator();
      // Refresh sidebar from server (will reconcile with optimistic update)
      loadConversationList();
      break;

    case 'error':
      var errorData;
      try {
        errorData = JSON.parse(data);
      } catch (e) {
        errorData = { error: data };
      }
      showError(errorData.error || 'An error occurred during streaming');
      setStreamingState(false);
      hidePhaseBar();
      removeToolIndicator();
      break;

    case 'status':
      // Status events can update the phase bar
      var statusData;
      try {
        statusData = JSON.parse(data);
      } catch (e) {
        statusData = {};
      }
      if (statusData.status) {
        // Map status strings to phases
        var statusPhaseMap = {
          'thinking': 'understanding',
          'understanding': 'understanding',
          'researching': 'researching',
          'searching': 'researching',
          'synthesizing': 'synthesising',
          'synthesising': 'synthesising',
          'writing': 'synthesising'
        };
        var mappedPhase = statusPhaseMap[statusData.status.toLowerCase()] || null;
        if (mappedPhase) {
          showPhaseBar(mappedPhase);
        }
      }
      break;

    case 'tool_status':
      // Show tool usage in the chat as a subtle indicator
      var toolData;
      try {
        toolData = JSON.parse(data);
      } catch (e) {
        toolData = {};
      }
      if (toolData.name && toolData.status === 'running') {
        showToolIndicator(toolData.name);
      }
      break;

    case 'skill_active':
      var skillData;
      try {
        skillData = JSON.parse(data);
      } catch (e) {
        skillData = {};
      }
      if (skillData.skillId) {
        showToolIndicator('Skill: ' + skillData.skillId);
      }
      break;

    default:
      // Ignore unknown events
      break;
  }
}


/**
 * Show the phase bar and set the active phase.
 * @param {string} phase - One of 'understanding', 'researching', 'synthesising'
 */
function showPhaseBar(phase) {
  var phaseBar = document.getElementById('phase-bar');
  if (!phaseBar) return;

  phaseBar.classList.add('visible');

  var phases = ['understanding', 'researching', 'synthesising'];
  var phaseIndex = phases.indexOf(phase);

  var items = phaseBar.querySelectorAll('.phase-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.remove('active', 'completed');
    if (i < phaseIndex) {
      items[i].classList.add('completed');
    } else if (i === phaseIndex) {
      items[i].classList.add('active');
    }
  }
}

/**
 * Hide the phase bar.
 */
function hidePhaseBar() {
  var phaseBar = document.getElementById('phase-bar');
  if (phaseBar) {
    phaseBar.classList.remove('visible');
  }
}

/**
 * Show a tool/skill usage indicator in the chat area.
 * @param {string} toolName
 */
function showToolIndicator(toolName) {
  var messagesInner = document.getElementById('chat-messages-inner');
  if (!messagesInner) return;

  // Remove any existing tool indicator
  var existing = messagesInner.querySelector('.tool-indicator');
  if (existing) existing.remove();

  var indicator = document.createElement('div');
  indicator.className = 'tool-indicator';
  indicator.innerHTML = '<span class="tool-indicator-icon">🔧</span> <span class="tool-indicator-text">Using: ' + escapeHtml(toolName) + '</span>';
  messagesInner.appendChild(indicator);

  // Scroll to bottom
  var chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

/**
 * Remove the tool indicator from the chat area.
 */
function removeToolIndicator() {
  var messagesInner = document.getElementById('chat-messages-inner');
  if (!messagesInner) return;
  var existing = messagesInner.querySelector('.tool-indicator');
  if (existing) existing.remove();
}

/**
 * Update the last assistant message bubble content without re-rendering all messages.
 * @param {string} content
 */
function updateLastAssistantMessage(content) {
  var messagesInner = document.getElementById('chat-messages-inner');
  if (!messagesInner) return;

  var messageBubbles = messagesInner.querySelectorAll('.message-bubble.assistant');
  if (messageBubbles.length > 0) {
    var lastBubble = messageBubbles[messageBubbles.length - 1];
    var contentEl = lastBubble.querySelector('.message-content');
    if (contentEl) {
      contentEl.textContent = content;
    }
  }

  // Scroll to bottom
  var chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

/**
 * Render all messages in the chat area.
 */
function renderMessages() {
  var messagesInner = document.getElementById('chat-messages-inner');
  var emptyState = document.getElementById('chat-empty-state');

  if (!messagesInner) return;

  if (messages.length === 0) {
    // Show empty state
    if (emptyState) emptyState.style.display = '';
    // Remove all message bubbles but keep empty state
    var existingMessages = messagesInner.querySelectorAll('.message-bubble');
    for (var k = 0; k < existingMessages.length; k++) {
      existingMessages[k].remove();
    }
    return;
  }

  // Hide empty state
  if (emptyState) emptyState.style.display = 'none';

  var html = '';
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var roleClass = msg.role === 'user' ? 'user' : 'assistant';
    html += '<div class="message-bubble ' + roleClass + '">' +
      '<div class="message-content">' + escapeHtml(msg.content) + '</div>' +
      '</div>';
  }

  messagesInner.innerHTML = html;

  // Scroll to bottom
  var chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

/**
 * Set the streaming state — disable/enable input and send button.
 * @param {boolean} streaming
 */
function setStreamingState(streaming) {
  isStreaming = streaming;
  var sendBtn = document.getElementById('send-btn');
  var chatInput = document.getElementById('chat-input');

  if (sendBtn) {
    sendBtn.disabled = streaming;
    sendBtn.setAttribute('aria-disabled', streaming ? 'true' : 'false');
  }

  if (chatInput) {
    chatInput.disabled = streaming;
  }
}

/**
 * Show an error message in the chat area.
 * @param {string} message
 */
function showError(message) {
  var messagesInner = document.getElementById('chat-messages-inner');
  if (!messagesInner) return;

  var errorEl = document.createElement('div');
  errorEl.className = 'message-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.textContent = message;
  messagesInner.appendChild(errorEl);

  // Scroll to bottom
  var chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

/**
 * Format a date string as a relative timestamp.
 * @param {string} dateStr - ISO date string
 * @returns {string} Relative time string (e.g., "just now", "5m ago", "2h ago", "3d ago")
 */
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';

  var date = new Date(dateStr);
  var now = new Date();
  var diffMs = now - date;
  var diffSec = Math.floor(diffMs / 1000);
  var diffMin = Math.floor(diffSec / 60);
  var diffHour = Math.floor(diffMin / 60);
  var diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return diffMin + 'm ago';
  if (diffHour < 24) return diffHour + 'h ago';
  if (diffDay < 30) return diffDay + 'd ago';

  // For older dates, show the date
  return date.toLocaleDateString();
}

/**
 * Escape HTML special characters to prevent XSS when injecting user-provided text.
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML insertion
 */
function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/**
 * Escape a string for use in HTML attributes.
 * @param {string} str
 * @returns {string}
 */
function escapeHtmlAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
