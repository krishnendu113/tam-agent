/**
 * Unit tests for src/adminInfraToggle.js — Admin API endpoint for infra toggle
 * Requirements: 10.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock AWS SDK modules before importing the router
vi.mock('@aws-sdk/client-apprunner', () => ({
  AppRunnerClient: vi.fn(() => ({ send: vi.fn() })),
  PauseServiceCommand: vi.fn(),
  ResumeServiceCommand: vi.fn(),
  DescribeServiceCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-docdb', () => ({
  DocDBClient: vi.fn(() => ({ send: vi.fn() })),
  StopDBClusterCommand: vi.fn(),
  StartDBClusterCommand: vi.fn(),
  DescribeDBClustersCommand: vi.fn(),
}));

// Mock the infra-toggle executeStop/executeStart functions
vi.mock('../../scripts/infra-toggle.js', () => ({
  executeStop: vi.fn(),
  executeStart: vi.fn(),
  logStep: vi.fn(),
  validateEnv: vi.fn(),
}));

import { executeStop, executeStart } from '../../scripts/infra-toggle.js';

/**
 * Helper to create mock Express req/res objects.
 */
function createMockReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

/**
 * Extract the POST '/' handler from the router.
 * Express Router stores route layers internally.
 */
async function getHandler() {
  const mod = await import('../adminInfraToggle.js');
  const router = mod.default;
  // Find the POST handler in the router stack
  const layer = router.stack.find(
    (l) => l.route && l.route.methods.post && l.route.path === '/'
  );
  if (!layer) throw new Error('POST / handler not found on router');
  // The handler is the last function in the route stack
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

describe('adminInfraToggle - POST /api/admin/infra-toggle', () => {
  let handler;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.APPRUNNER_SERVICE_ARN = 'arn:aws:apprunner:us-east-1:123:service/test-svc';
    process.env.DOCDB_CLUSTER_IDENTIFIER = 'test-cluster';
    handler = await getHandler();
  });

  afterEach(() => {
    delete process.env.APPRUNNER_SERVICE_ARN;
    delete process.env.DOCDB_CLUSTER_IDENTIFIER;
  });

  describe('input validation', () => {
    it('returns 400 when action is missing', async () => {
      const { req, res } = createMockReqRes({});

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid action') })
      );
    });

    it('returns 400 when action is invalid', async () => {
      const { req, res } = createMockReqRes({ action: 'restart' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Invalid action') })
      );
    });

    it('returns 400 when body is null', async () => {
      const req = { body: null };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('environment validation', () => {
    it('returns 500 when APPRUNNER_SERVICE_ARN is missing', async () => {
      delete process.env.APPRUNNER_SERVICE_ARN;
      const { req, res } = createMockReqRes({ action: 'stop' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('APPRUNNER_SERVICE_ARN'),
        })
      );
    });

    it('returns 500 when DOCDB_CLUSTER_IDENTIFIER is missing', async () => {
      delete process.env.DOCDB_CLUSTER_IDENTIFIER;
      const { req, res } = createMockReqRes({ action: 'start' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('DOCDB_CLUSTER_IDENTIFIER'),
        })
      );
    });
  });

  describe('stop action', () => {
    it('calls executeStop and returns 200 on success', async () => {
      executeStop.mockResolvedValue(undefined);
      const { req, res } = createMockReqRes({ action: 'stop' });

      await handler(req, res);

      expect(executeStop).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceArn: 'arn:aws:apprunner:us-east-1:123:service/test-svc',
          clusterIdentifier: 'test-cluster',
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, action: 'stop' });
    });

    it('returns 500 when executeStop throws AWS error', async () => {
      const awsError = new Error('Service is not in a state to be paused');
      awsError.Code = 'InvalidStateException';
      executeStop.mockRejectedValue(awsError);
      const { req, res } = createMockReqRes({ action: 'stop' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Infrastructure toggle failed',
          details: expect.objectContaining({
            errorCode: 'InvalidStateException',
            errorMessage: 'Service is not in a state to be paused',
          }),
        })
      );
    });
  });

  describe('start action', () => {
    it('calls executeStart and returns 200 on success', async () => {
      executeStart.mockResolvedValue(true);
      const { req, res } = createMockReqRes({ action: 'start' });

      await handler(req, res);

      expect(executeStart).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceArn: 'arn:aws:apprunner:us-east-1:123:service/test-svc',
          clusterIdentifier: 'test-cluster',
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, action: 'start' });
    });

    it('returns 500 when executeStart throws AWS error', async () => {
      const awsError = new Error('Cluster not found');
      awsError.name = 'DBClusterNotFoundFault';
      executeStart.mockRejectedValue(awsError);
      const { req, res } = createMockReqRes({ action: 'start' });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Infrastructure toggle failed',
          details: expect.objectContaining({
            errorCode: 'DBClusterNotFoundFault',
            errorMessage: 'Cluster not found',
          }),
        })
      );
    });
  });
});
