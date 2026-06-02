#!/usr/bin/env node

/**
 * Infrastructure Toggle CLI
 *
 * Starts or stops App Runner + DocumentDB for cost control.
 * Usage: node scripts/infra-toggle.js start|stop
 *
 * Required env vars:
 *   APPRUNNER_SERVICE_ARN - App Runner service ARN
 *   DOCDB_CLUSTER_IDENTIFIER - DocumentDB cluster identifier
 *
 * AWS credentials resolved via default provider chain.
 */

import {
  AppRunnerClient,
  PauseServiceCommand,
  ResumeServiceCommand,
  DescribeServiceCommand,
} from '@aws-sdk/client-apprunner';

import {
  DocDBClient,
  StopDBClusterCommand,
  StartDBClusterCommand,
  DescribeDBClustersCommand,
} from '@aws-sdk/client-docdb';

// ─── Configuration ──────────────────────────────────────────────────────────────

const HEALTH_CHECK_TIMEOUT_MS = 120_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;

// ─── Logging ────────────────────────────────────────────────────────────────────

/**
 * Logs an infrastructure operation step with timestamp.
 */
export function logStep(operation, resource, status) {
  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    resource,
    status,
  };
  console.log(JSON.stringify(entry));
}

// ─── Environment Validation ─────────────────────────────────────────────────────

/**
 * Validates required env vars are set. Exits with error if missing.
 * @returns {{ serviceArn: string, clusterIdentifier: string }}
 */
export function validateEnv() {
  const serviceArn = process.env.APPRUNNER_SERVICE_ARN;
  const clusterIdentifier = process.env.DOCDB_CLUSTER_IDENTIFIER;

  const missing = [];
  if (!serviceArn) missing.push('APPRUNNER_SERVICE_ARN');
  if (!clusterIdentifier) missing.push('DOCDB_CLUSTER_IDENTIFIER');

  if (missing.length > 0) {
    const msg = `Missing required environment variables: ${missing.join(', ')}`;
    console.error(msg);
    process.exit(1);
  }

  return { serviceArn, clusterIdentifier };
}

// ─── App Runner Operations ──────────────────────────────────────────────────────

/**
 * Pauses the App Runner service.
 * @param {AppRunnerClient} client
 * @param {string} serviceArn
 */
export async function pauseService(client, serviceArn) {
  logStep('PauseService', serviceArn, 'initiated');
  const command = new PauseServiceCommand({ ServiceArn: serviceArn });
  const response = await client.send(command);
  const status = response.Service?.Status || 'UNKNOWN';
  logStep('PauseService', serviceArn, status);
  return response;
}

/**
 * Resumes the App Runner service.
 * @param {AppRunnerClient} client
 * @param {string} serviceArn
 */
export async function resumeService(client, serviceArn) {
  logStep('ResumeService', serviceArn, 'initiated');
  const command = new ResumeServiceCommand({ ServiceArn: serviceArn });
  const response = await client.send(command);
  const status = response.Service?.Status || 'UNKNOWN';
  logStep('ResumeService', serviceArn, status);
  return response;
}

// ─── DocumentDB Operations ──────────────────────────────────────────────────────

/**
 * Stops the DocumentDB cluster.
 * @param {DocDBClient} client
 * @param {string} clusterIdentifier
 */
export async function stopCluster(client, clusterIdentifier) {
  logStep('StopDBCluster', clusterIdentifier, 'initiated');
  const command = new StopDBClusterCommand({ DBClusterIdentifier: clusterIdentifier });
  const response = await client.send(command);
  const status = response.DBCluster?.Status || 'stopping';
  logStep('StopDBCluster', clusterIdentifier, status);
  return response;
}

/**
 * Starts the DocumentDB cluster.
 * @param {DocDBClient} client
 * @param {string} clusterIdentifier
 */
export async function startCluster(client, clusterIdentifier) {
  logStep('StartDBCluster', clusterIdentifier, 'initiated');
  const command = new StartDBClusterCommand({ DBClusterIdentifier: clusterIdentifier });
  const response = await client.send(command);
  const status = response.DBCluster?.Status || 'starting';
  logStep('StartDBCluster', clusterIdentifier, status);
  return response;
}

// ─── Health Check ───────────────────────────────────────────────────────────────

/**
 * Polls the App Runner service until it reports RUNNING status or timeout.
 * @param {AppRunnerClient} client
 * @param {string} serviceArn
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>} true if healthy, false if timed out
 */
export async function healthCheck(client, serviceArn, timeoutMs = HEALTH_CHECK_TIMEOUT_MS, intervalMs = HEALTH_CHECK_INTERVAL_MS) {
  logStep('HealthCheck', serviceArn, 'polling');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const command = new DescribeServiceCommand({ ServiceArn: serviceArn });
      const response = await client.send(command);
      const status = response.Service?.Status;

      if (status === 'RUNNING') {
        logStep('HealthCheck', serviceArn, 'healthy');
        return true;
      }
    } catch (err) {
      // Polling error — continue retrying until deadline
    }

    await sleep(intervalMs);
  }

  logStep('HealthCheck', serviceArn, 'timeout');
  return false;
}

/**
 * Utility sleep function.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

/**
 * Executes the stop sequence: pause App Runner → stop DocumentDB.
 * @param {object} options
 * @param {AppRunnerClient} options.appRunnerClient
 * @param {DocDBClient} options.docDbClient
 * @param {string} options.serviceArn
 * @param {string} options.clusterIdentifier
 */
export async function executeStop({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier }) {
  await pauseService(appRunnerClient, serviceArn);
  await stopCluster(docDbClient, clusterIdentifier);
}

/**
 * Executes the start sequence: start DocumentDB → resume App Runner → health check.
 * @param {object} options
 * @param {AppRunnerClient} options.appRunnerClient
 * @param {DocDBClient} options.docDbClient
 * @param {string} options.serviceArn
 * @param {string} options.clusterIdentifier
 * @returns {Promise<boolean>} true if healthy after start
 */
export async function executeStart({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier }) {
  await startCluster(docDbClient, clusterIdentifier);
  await resumeService(appRunnerClient, serviceArn);

  const healthy = await healthCheck(appRunnerClient, serviceArn);
  if (!healthy) {
    console.error('WARNING: Service may not be fully operational — health check timed out after 120s');
    return false;
  }
  return true;
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────────

async function main() {
  const action = process.argv[2];

  if (!action || !['start', 'stop'].includes(action)) {
    console.error('Usage: node scripts/infra-toggle.js <start|stop>');
    process.exit(1);
  }

  const { serviceArn, clusterIdentifier } = validateEnv();

  const appRunnerClient = new AppRunnerClient();
  const docDbClient = new DocDBClient();

  try {
    if (action === 'stop') {
      await executeStop({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier });
      logStep('InfraToggle', 'all', 'stopped');
    } else {
      const healthy = await executeStart({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier });
      if (!healthy) {
        process.exit(1);
      }
      logStep('InfraToggle', 'all', 'started');
    }
  } catch (err) {
    const errorInfo = {
      timestamp: new Date().toISOString(),
      operation: 'InfraToggle',
      action,
      status: 'FAILED',
      errorCode: err.Code || err.name || 'UnknownError',
      errorMessage: err.message,
    };
    console.error(JSON.stringify(errorInfo));
    process.exit(1);
  }
}

// Run CLI when executed directly
const isDirectExecution = process.argv[1]?.includes('infra-toggle');
if (isDirectExecution) {
  main();
}
