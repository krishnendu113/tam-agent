import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

import { runAgentLoop } from './agentLoop.js';
import { createCallbackInterface } from './callbacks.js';
import { authMiddleware, googleAuthRedirect, googleAuthCallback } from './auth.js';
import { connectDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Standard middleware
app.use(cors());
app.use(helmet());
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

// Chat endpoint with SSE streaming (protected)
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { conversationId, messages, systemPrompt, problemText } = req.body;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Build AgentState from incoming request
  const state = {
    conversationId: conversationId || null,
    messages: messages || [],
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
    onComplete: (text) => {
      res.write(`event: complete\ndata: ${JSON.stringify({ text })}\n\n`);
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
