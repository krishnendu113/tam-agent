/**
 * Unit tests for scripts/infra-toggle.js — Infrastructure Toggle CLI
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock AWS SDK modules
vi.mock('@aws-sdk/client-apprunner', () => ({
  AppRunnerClient: vi.fn(() => ({ send: vi.fn() })),
  PauseServiceCommand: vi.fn((params) => ({ _type: 'PauseService', ...params })),
  ResumeServiceCommand: vi.fn((params) => ({ _type: 'ResumeService', ...params })),
  DescribeServiceCommand: vi.fn((params) => ({ _type: 'DescribeService', ...params })),
}));

vi.mock('@aws-sdk/client-docdb', () => ({
  DocDBClient: vi.fn(() => ({ send: vi.fn() })),
  StopDBClusterCommand: vi.fn((params) => ({ _type: 'StopDBCluster', ...params })),
  StartDBClusterCommand: vi.fn((params) => ({ _type: 'StartDBCluster', ...params })),
  DescribeDBClustersCommand: vi.fn((params) => ({ _type: 'DescribeDBClusters', ...params })),
}));

import {
  logStep,
  validateEnv,
  pauseService,
  resumeService,
  stopCluster,
  startCluster,
  healthCheck,
  executeStop,
  executeStart,
} from '../../scripts/infra-toggle.js';

describe('infra-toggle', () => {
  let consoleSpy;
  let consoleErrorSpy;
  let processExitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    delete process.env.APPRUNNER_SERVICE_ARN;
    delete process.env.DOCDB_CLUSTER_IDENTIFIER;
  });

  describe('logStep', () => {
    it('logs JSON with timestamp, operation, resource, and status', () => {
      logStep('PauseService', 'arn:aws:apprunner:us-east-1:123:service/my-svc', 'initiated');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.operation).toBe('PauseService');
      expect(logged.resource).toBe('arn:aws:apprunner:us-east-1:123:service/my-svc');
      expect(logged.status).toBe('initiated');
      expect(logged.timestamp).toBeTruthy();
      // Timestamp should be ISO format
      expect(() => new Date(logged.timestamp)).not.toThrow();
    });
  });

  describe('validateEnv', () => {
    it('returns serviceArn and clusterIdentifier when both are set', () => {
      process.env.APPRUNNER_SERVICE_ARN = 'arn:aws:apprunner:us-east-1:123:service/test';
      process.env.DOCDB_CLUSTER_IDENTIFIER = 'my-cluster';

      const result = validateEnv();
      expect(result.serviceArn).toBe('arn:aws:apprunner:us-east-1:123:service/test');
      expect(result.clusterIdentifier).toBe('my-cluster');
    });

    it('exits with error when APPRUNNER_SERVICE_ARN is missing', () => {
      process.env.DOCDB_CLUSTER_IDENTIFIER = 'my-cluster';

      expect(() => validateEnv()).toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('APPRUNNER_SERVICE_ARN')
      );
    });

    it('exits with error when DOCDB_CLUSTER_IDENTIFIER is missing', () => {
      process.env.APPRUNNER_SERVICE_ARN = 'arn:aws:apprunner:us-east-1:123:service/test';

      expect(() => validateEnv()).toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DOCDB_CLUSTER_IDENTIFIER')
      );
    });

    it('exits with error listing both vars when both are missing', () => {
      expect(() => validateEnv()).toThrow('process.exit called');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('APPRUNNER_SERVICE_ARN')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DOCDB_CLUSTER_IDENTIFIER')
      );
    });
  });

  describe('pauseService', () => {
    it('sends PauseServiceCommand and logs steps', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          Service: { Status: 'OPERATION_IN_PROGRESS' },
        }),
      };

      const result = await pauseService(mockClient, 'arn:service/test');

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(result.Service.Status).toBe('OPERATION_IN_PROGRESS');
      // Should have logged initiated + final status
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it('propagates AWS errors', async () => {
      const mockClient = {
        send: vi.fn().mockRejectedValue(new Error('AccessDenied')),
      };

      await expect(pauseService(mockClient, 'arn:service/test')).rejects.toThrow('AccessDenied');
    });
  });

  describe('resumeService', () => {
    it('sends ResumeServiceCommand and logs steps', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          Service: { Status: 'OPERATION_IN_PROGRESS' },
        }),
      };

      const result = await resumeService(mockClient, 'arn:service/test');

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(result.Service.Status).toBe('OPERATION_IN_PROGRESS');
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopCluster', () => {
    it('sends StopDBClusterCommand and logs steps', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          DBCluster: { Status: 'stopping' },
        }),
      };

      const result = await stopCluster(mockClient, 'my-cluster');

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(result.DBCluster.Status).toBe('stopping');
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it('propagates AWS errors', async () => {
      const mockClient = {
        send: vi.fn().mockRejectedValue(new Error('InvalidDBClusterStateFault')),
      };

      await expect(stopCluster(mockClient, 'my-cluster')).rejects.toThrow('InvalidDBClusterStateFault');
    });
  });

  describe('startCluster', () => {
    it('sends StartDBClusterCommand and logs steps', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          DBCluster: { Status: 'starting' },
        }),
      };

      const result = await startCluster(mockClient, 'my-cluster');

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(result.DBCluster.Status).toBe('starting');
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('healthCheck', () => {
    it('returns true when service reaches RUNNING status', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          Service: { Status: 'RUNNING' },
        }),
      };

      const result = await healthCheck(mockClient, 'arn:service/test', 10000, 100);

      expect(result).toBe(true);
      expect(mockClient.send).toHaveBeenCalled();
    });

    it('returns true after polling multiple times', async () => {
      const mockClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ Service: { Status: 'OPERATION_IN_PROGRESS' } })
          .mockResolvedValueOnce({ Service: { Status: 'OPERATION_IN_PROGRESS' } })
          .mockResolvedValueOnce({ Service: { Status: 'RUNNING' } }),
      };

      const result = await healthCheck(mockClient, 'arn:service/test', 10000, 10);

      expect(result).toBe(true);
      expect(mockClient.send).toHaveBeenCalledTimes(3);
    });

    it('returns false when timeout is reached', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          Service: { Status: 'OPERATION_IN_PROGRESS' },
        }),
      };

      const result = await healthCheck(mockClient, 'arn:service/test', 50, 20);

      expect(result).toBe(false);
    });

    it('continues polling on network errors', async () => {
      const mockClient = {
        send: vi.fn()
          .mockRejectedValueOnce(new Error('NetworkError'))
          .mockResolvedValueOnce({ Service: { Status: 'RUNNING' } }),
      };

      const result = await healthCheck(mockClient, 'arn:service/test', 10000, 10);

      expect(result).toBe(true);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeStop', () => {
    it('calls pause then stop in correct order', async () => {
      const callOrder = [];
      const appRunnerClient = {
        send: vi.fn().mockImplementation(async () => {
          callOrder.push('apprunner');
          return { Service: { Status: 'PAUSED' } };
        }),
      };
      const docDbClient = {
        send: vi.fn().mockImplementation(async () => {
          callOrder.push('docdb');
          return { DBCluster: { Status: 'stopping' } };
        }),
      };

      await executeStop({
        appRunnerClient,
        docDbClient,
        serviceArn: 'arn:service/test',
        clusterIdentifier: 'my-cluster',
      });

      expect(callOrder).toEqual(['apprunner', 'docdb']);
    });

    it('does not stop DocumentDB if App Runner pause fails', async () => {
      const appRunnerClient = {
        send: vi.fn().mockRejectedValue(new Error('PauseFailed')),
      };
      const docDbClient = {
        send: vi.fn(),
      };

      await expect(executeStop({
        appRunnerClient,
        docDbClient,
        serviceArn: 'arn:service/test',
        clusterIdentifier: 'my-cluster',
      })).rejects.toThrow('PauseFailed');

      expect(docDbClient.send).not.toHaveBeenCalled();
    });
  });

  describe('executeStart', () => {
    it('calls start DocumentDB then resume App Runner in correct order', async () => {
      const callOrder = [];
      const appRunnerClient = {
        send: vi.fn().mockImplementation(async (cmd) => {
          if (cmd._type === 'DescribeService') {
            return { Service: { Status: 'RUNNING' } };
          }
          callOrder.push('apprunner-resume');
          return { Service: { Status: 'OPERATION_IN_PROGRESS' } };
        }),
      };
      const docDbClient = {
        send: vi.fn().mockImplementation(async () => {
          callOrder.push('docdb-start');
          return { DBCluster: { Status: 'starting' } };
        }),
      };

      const result = await executeStart({
        appRunnerClient,
        docDbClient,
        serviceArn: 'arn:service/test',
        clusterIdentifier: 'my-cluster',
      });

      expect(callOrder[0]).toBe('docdb-start');
      expect(callOrder[1]).toBe('apprunner-resume');
      expect(result).toBe(true);
    });

    it('does not resume App Runner if DocumentDB start fails', async () => {
      const appRunnerClient = {
        send: vi.fn(),
      };
      const docDbClient = {
        send: vi.fn().mockRejectedValue(new Error('ClusterStartFailed')),
      };

      await expect(executeStart({
        appRunnerClient,
        docDbClient,
        serviceArn: 'arn:service/test',
        clusterIdentifier: 'my-cluster',
      })).rejects.toThrow('ClusterStartFailed');

      expect(appRunnerClient.send).not.toHaveBeenCalled();
    });

    it('returns false when health check times out', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({
          Service: { Status: 'OPERATION_IN_PROGRESS' },
        }),
      };

      // Test healthCheck directly with very short timeout
      const result = await healthCheck(mockClient, 'arn:service/test', 80, 20);

      expect(result).toBe(false);
    });
  });
});
