import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { ObjectId } from 'mongodb';
import { runAgentLoop } from './agentLoop.js';
import { createCallbackInterface } from './callbacks.js';
import { authMiddleware, googleAuthRedirect, googleAuthCallback } from './auth.js';
import { connectDb, getDb } from './db.js';
import { adminLoginHandler, bootstrapSuperAdmin, enhancedAuthMiddleware, adminMiddleware } from './adminAuth.js';
import { conversationsRouter, createConversationIndexes } from './conversations.js';
import adminRoutes from './adminRoutes.js';
import adminInfraToggle from './adminInfraToggle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Standard middleware
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(morgan('combined'));
app.use(express.json());

// Serve static files from public/ directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Google OAuth routes (public)
app.get('/auth/google', googleAuthRedirect);
app.get('/auth/google/callback', googleAuthCallback);

// Admin login route (public)
app.post('/api/auth/admin-login', adminLoginHandler);

// Conversations routes (protected)
app.use('/api/conversations', enhancedAuthMiddleware, conversationsRouter);

// Admin user management routes (protected + admin only)
app.use('/api/admin/users', enhancedAuthMiddleware, adminMiddleware, adminRoutes);

// Admin infra toggle route (protected + admin only)
app.use('/api/admin/infra-toggle', enhancedAuthMiddleware, adminMiddleware, adminInfraToggle);

// Chat endpoint with SSE streaming (protected)
app.post('/api/chat', enhancedAuthMiddleware, async (req, res) => {
  const { conversationId, messages, systemPrompt, problemText } = req.body;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Determine or create conversationId for persistence
  let activeConversationId = conversationId || null;

  try {
    if (!activeConversationId) {
      // Create a new conversation document
      const db = getDb();
      const userMessages = (messages || []).filter(m => m.role === 'user');
      const firstUserMessage = userMessages.length > 0 ? userMessages[0].content : 'New conversation';
      const title = firstUserMessage.substring(0, 100).trim();

      const now = new Date();
      const result = await db.collection('conversations').insertOne({
        userId: req.user.email,
        title,
        messages: [],
        createdAt: now,
        updatedAt: now,
      });
      activeConversationId = result.insertedId.toString();
    }
  } catch (err) {
    console.error('[chat] Error creating conversation:', err.message);
    // Continue without persistence if DB fails
  }

  // Build AgentState from incoming request
  // Strip any extra fields from messages (only role and content are needed for the LLM)
  const sanitizedMessages = (messages || []).map(m => ({ role: m.role, content: m.content }));

  const state = {
    conversationId: activeConversationId,
    messages: sanitizedMessages,
    systemPrompt: systemPrompt || '',
    problemText: problemText || '',
  };

  // Build CallbackInterface mapping callbacks to SSE event types
  const callbacks = createCallbackInterface({
    onToken: (text) => res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`),
    onStatus: (status) => res.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`),
    onPhase: (phase) => res.write(`event: phase\ndata: ${JSON.stringify({ phase })}\n\n`),
    onToolStatus: (name, status) => res.write(`event: tool_status\ndata: ${JSON.stringify({ name, status })}\n\n`),
    onSkillActive: (skillId) => res.write(`event: skill_active\ndata: ${JSON.stringify({ skillId })}\n\n`),
    onPlanUpdate: (plan) => res.write(`event: plan_update\ndata: ${JSON.stringify({ plan })}\n\n`),
    onDocumentReady: (doc) => res.write(`event: document_ready\ndata: ${JSON.stringify({ doc })}\n\n`),
    onError: (error) => res.write(`event: error\ndata: ${JSON.stringify({ error: error.message || error })}\n\n`),
    onComplete: async (text) => {
      // Persist messages to the conversation
      try {
        if (activeConversationId) {
          const db = getDb();
          const now = new Date();
          const userMessages = (messages || []).filter(m => m.role === 'user');
          const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';

          const messagesToAppend = [];
          if (lastUserMessage) {
            messagesToAppend.push({ role: 'user', content: lastUserMessage, timestamp: now });
          }
          messagesToAppend.push({ role: 'assistant', content: text, timestamp: now });

          await db.collection('conversations').updateOne(
            { _id: new ObjectId(activeConversationId) },
            {
              $push: { messages: { $each: messagesToAppend } },
              $set: { updatedAt: now },
            }
          );
        }
      } catch (err) {
        console.error('[chat] Error persisting messages:', err.message);
      }

      res.write(`event: complete\ndata: ${JSON.stringify({ text, conversationId: activeConversationId })}\n\n`);
      res.end();
    },
  });

  try {
    await runAgentLoop(state, callbacks);
    // If onComplete wasn't called (e.g., error path), ensure connection closes
    if (!res.writableEnded) {
      res.end();
    }
  } catch (error) {
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: error.message || 'Internal server error' })}\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;

// Only start listening if this file is run directly (not imported for testing)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startServer = async () => {
    // Connect to MongoDB if using mongo backend
    const storeBackend = process.env.STORE_BACKEND || 'json';
    if (storeBackend === 'mongodb' || storeBackend === 'mongo') {
      try {
        await connectDb();
        await bootstrapSuperAdmin();
        await createConversationIndexes();
      } catch (err) {
        console.error('[server] Failed to connect to MongoDB:', err.message);
        process.exit(1);
      }
    }

    app.listen(PORT, () => {
      console.log(`TAM Agent server running on port ${PORT}`);
    });
  };

  startServer();
}

export { app };
