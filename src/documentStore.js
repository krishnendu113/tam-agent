// PLACEHOLDER: This module should be replaced with the actual source from the source repository.
// Document store module - manages generated documents (reports, summaries, etc.).

import { createStore } from './stores/index.js';

const docStore = createStore('documents');

/**
 * Stores a generated document.
 * @param {object} options - Document options
 * @param {string} options.conversationId - Associated conversation ID
 * @param {string} options.title - Document title
 * @param {string} options.content - Document content (markdown, HTML, etc.)
 * @param {string} [options.format] - Document format ('markdown', 'html', 'text')
 * @returns {Promise<object>} Stored document metadata
 */
export async function storeDocument({ conversationId, title, content, format = 'markdown' }) {
  const doc = {
    id: `doc_${Date.now()}`,
    conversationId,
    title,
    content,
    format,
    createdAt: new Date().toISOString()
  };

  await docStore.set(doc.id, doc);
  return { id: doc.id, title: doc.title, format: doc.format, createdAt: doc.createdAt };
}

/**
 * Retrieves a document by ID.
 * @param {string} docId - Document ID
 * @returns {Promise<object|null>} Document or null
 */
export async function getDocument(docId) {
  return docStore.get(docId);
}

/**
 * Lists documents for a conversation.
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<Array>} Array of document metadata
 */
export async function listDocuments(conversationId) {
  const all = await docStore.list();
  return all
    .filter(doc => doc.conversationId === conversationId)
    .map(({ id, title, format, createdAt }) => ({ id, title, format, createdAt }));
}

export default { storeDocument, getDocument, listDocuments };
