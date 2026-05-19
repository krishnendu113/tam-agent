/**
 * Chat Module
 * Handles the chat interface: conversation sidebar, message sending,
 * SSE streaming, and conversation loading.
 *
 * Dependencies: auth.js (requireAuth, getToken), api.js (apiGet), nav.js (renderNav)
 */

/* global requireAuth, getToken, apiGet, renderNav, escapeHtml */

/** @type {string|null} */
var currentConversationId = null;

/** @type {Array<{role: string, content: string}>} */
var messages = [];

/** @type {boolean} */
var isStreaming = false;

/**
 * Initialize the chat page on load.
 */
(function init() {
  requireAuth();
  renderNav('navbar');
  loadConversationList();
  attachEventListeners();
})();

/**
 * Attach event listeners for send button, input, sidebar toggle, and new conversation.
 */
function attachEventListeners() {
  var sendBtn = document.getElementById('send-btn');
  var chatInput = document.getElementById('chat-input');
  var newConvBtn = document.getElementById('new-conversation-btn');
  var sidebarToggle = document.getElementById('sidebar-toggle');
  var sidebarOverlay = document.getElementById('sidebar-overlay');

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
 * Load the conversation list from the API and render in the sidebar.
 */
async function loadConversationList() {
  try {
    var response = await apiGet('/api/conversations');
    if (!response.ok) return;

    var conversations = await response.json();
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
        messages: messages
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
      return;
    }

    // Process the SSE stream
    await processSSEStream(response);
  } catch (e) {
    showError('Connection error. Please try again.');
    setStreamingState(false);
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
        tokenData = { token: data };
      }
      var tokenText = tokenData.token || tokenData.content || data;
      var newContent = contentRef.getContent() + tokenText;
      contentRef.setContent(newContent);

      // Update the last assistant message
      messages[messages.length - 1].content = newContent;
      updateLastAssistantMessage(newContent);
      break;

    case 'complete':
      var completeData;
      try {
        completeData = JSON.parse(data);
      } catch (e) {
        completeData = {};
      }

      // Update conversationId if provided
      if (completeData.conversationId) {
        currentConversationId = completeData.conversationId;
      }

      setStreamingState(false);
      loadConversationList(); // Refresh sidebar
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
      break;

    default:
      // Ignore unknown events (e.g., status, phase)
      break;
  }
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
