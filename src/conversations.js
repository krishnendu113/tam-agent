// Conversations API routes - list and retrieve user conversations.

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from './db.js';

const router = Router();

/**
 * GET /api/conversations
 * Returns conversations for the authenticated user, sorted by updatedAt descending.
 * Excludes the messages array for performance.
 */
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const conversations = await db
      .collection('conversations')
      .find(
        { userId: req.user.email },
        { projection: { _id: 1, title: 1, updatedAt: 1, createdAt: 1 } }
      )
      .sort({ updatedAt: -1 })
      .toArray();

    return res.status(200).json(conversations);
  } catch (err) {
    console.error('[conversations] Error listing conversations:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/conversations/:id
 * Returns a single conversation with all messages.
 * Verifies the conversation belongs to the authenticated user.
 */
router.get('/:id', async (req, res) => {
  try {
    let objectId;
    try {
      objectId = new ObjectId(req.params.id);
    } catch {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const db = getDb();
    const conversation = await db
      .collection('conversations')
      .findOne({ _id: objectId });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversation.userId !== req.user.email) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.status(200).json(conversation);
  } catch (err) {
    console.error('[conversations] Error fetching conversation:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Creates the required MongoDB indexes for the conversations collection.
 * Should be called during server startup.
 */
export async function createConversationIndexes() {
  try {
    const db = getDb();
    await db.collection('conversations').createIndex(
      { userId: 1, updatedAt: -1 }
    );
    console.log('[conversations] Indexes created.');
  } catch (err) {
    console.error('[conversations] Failed to create indexes:', err.message);
  }
}

export { router as conversationsRouter };
export default router;
