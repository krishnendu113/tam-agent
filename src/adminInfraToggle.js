/**
 * Admin API endpoint for infrastructure toggle.
 * POST /api/admin/infra-toggle
 *
 * Accepts JSON body: { action: "start" | "stop" }
 * Reuses logic from scripts/infra-toggle.js
 *
 * Requirements: 10.2
 */

import { Router } from 'express';
import { AppRunnerClient } from '@aws-sdk/client-apprunner';
import { DocDBClient } from '@aws-sdk/client-docdb';
import { executeStop, executeStart } from '../scripts/infra-toggle.js';

const router = Router();

/**
 * POST /api/admin/infra-toggle
 * Body: { action: "start" | "stop" }
 * Returns 200 on success, 400 for invalid action, 500 on AWS API failure.
 */
router.post('/', async (req, res) => {
  const { action } = req.body || {};

  // Validate action
  if (!action || !['start', 'stop'].includes(action)) {
    return res.status(400).json({
      error: 'Invalid action. Must be "start" or "stop".',
    });
  }

  // Validate env vars
  const serviceArn = process.env.APPRUNNER_SERVICE_ARN;
  const clusterIdentifier = process.env.DOCDB_CLUSTER_IDENTIFIER;

  const missing = [];
  if (!serviceArn) missing.push('APPRUNNER_SERVICE_ARN');
  if (!clusterIdentifier) missing.push('DOCDB_CLUSTER_IDENTIFIER');

  if (missing.length > 0) {
    return res.status(500).json({
      error: `Missing required environment variables: ${missing.join(', ')}`,
    });
  }

  const appRunnerClient = new AppRunnerClient();
  const docDbClient = new DocDBClient();

  try {
    if (action === 'stop') {
      await executeStop({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier });
    } else {
      await executeStart({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier });
    }

    return res.status(200).json({ success: true, action });
  } catch (err) {
    return res.status(500).json({
      error: 'Infrastructure toggle failed',
      details: {
        errorCode: err.Code || err.name || 'UnknownError',
        errorMessage: err.message,
      },
    });
  }
});

export default router;
