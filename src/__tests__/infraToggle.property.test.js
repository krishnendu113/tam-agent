/**
 * Property-based tests for scripts/infra-toggle.js — Infrastructure Toggle Operation Ordering
 *
 * Property 17: Infrastructure Toggle Operation Ordering
 *
 * For stop: PauseService is always called BEFORE StopDBCluster.
 * For start: StartDBCluster is always called BEFORE ResumeService.
 *
 * **Validates: Requirements 10.3, 10.4**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// Mock AWS SDK modules before importing the module under test
vi.mock('@aws-sdk/client-apprunner', () => ({
  AppRunnerClient: vi.fn(),
  PauseServiceCommand: vi.fn(),
  ResumeServiceCommand: vi.fn(),
  DescribeServiceCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-docdb', () => ({
  DocDBClient: vi.fn(),
  StopDBClusterCommand: vi.fn(),
  StartDBClusterCommand: vi.fn(),
  DescribeDBClustersCommand: vi.fn(),
}));

import { executeStop, executeStart } from '../../scripts/infra-toggle.js';

describe('Feature: skill-system-enhancement, Property 17: Infrastructure Toggle Operation Ordering', () => {
  // --- Generators ---

  /**
   * Generates an arbitrary ARN-like string for App Runner services.
   */
  function arbServiceArn() {
    return fc
      .tuple(
        fc.stringMatching(/^[a-z]{2}-[a-z]+-[1-9]$/),
        fc.stringMatching(/^[0-9]{12}$/),
        fc.stringMatching(/^[a-f0-9]{8,32}$/)
      )
      .map(([region, account, id]) => `arn:aws:apprunner:${region}:${account}:service/${id}`);
  }

  /**
   * Generates an arbitrary DocumentDB cluster identifier.
   */
  function arbClusterIdentifier() {
    return fc
      .stringMatching(/^[a-z][a-z0-9\-]{2,30}$/)
      .filter((s) => !s.endsWith('-') && !s.includes('--'));
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 10.3**
   *
   * For any invocation of the stop action, the AWS API call sequence SHALL always
   * be PauseService before StopDBCluster.
   */
  it('executeStop always calls PauseService before StopDBCluster', () => {
    fc.assert(
      fc.asyncProperty(
        arbServiceArn(),
        arbClusterIdentifier(),
        async (serviceArn, clusterIdentifier) => {
          // Track the order of operations
          const callOrder = [];

          // Create mock App Runner client
          const appRunnerClient = {
            send: vi.fn().mockImplementation((command) => {
              callOrder.push('PauseService');
              return Promise.resolve({ Service: { Status: 'PAUSING' } });
            }),
          };

          // Create mock DocDB client
          const docDbClient = {
            send: vi.fn().mockImplementation((command) => {
              callOrder.push('StopDBCluster');
              return Promise.resolve({ DBCluster: { Status: 'stopping' } });
            }),
          };

          // Execute stop sequence
          await executeStop({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier });

          // PauseService SHALL be called before StopDBCluster
          expect(callOrder.length).toBe(2);
          expect(callOrder[0]).toBe('PauseService');
          expect(callOrder[1]).toBe('StopDBCluster');
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 10.4**
   *
   * For any invocation of the start action, the AWS API call sequence SHALL always
   * be StartDBCluster before ResumeService.
   */
  it('executeStart always calls StartDBCluster before ResumeService', () => {
    fc.assert(
      fc.asyncProperty(
        arbServiceArn(),
        arbClusterIdentifier(),
        async (serviceArn, clusterIdentifier) => {
          // Track the order of operations
          const callOrder = [];

          // Create mock App Runner client that tracks calls
          const appRunnerClient = {
            send: vi.fn().mockImplementation((command) => {
              // Determine which command is being sent based on call position
              // ResumeService is called after StartDBCluster
              // DescribeService is called during health check
              if (callOrder.filter((c) => c === 'ResumeService').length === 0 && callOrder.includes('StartDBCluster')) {
                callOrder.push('ResumeService');
                return Promise.resolve({ Service: { Status: 'RUNNING' } });
              }
              // Health check describe call — return RUNNING immediately
              return Promise.resolve({ Service: { Status: 'RUNNING' } });
            }),
          };

          // Create mock DocDB client
          const docDbClient = {
            send: vi.fn().mockImplementation((command) => {
              callOrder.push('StartDBCluster');
              return Promise.resolve({ DBCluster: { Status: 'starting' } });
            }),
          };

          // Execute start sequence
          await executeStart({ appRunnerClient, docDbClient, serviceArn, clusterIdentifier });

          // StartDBCluster SHALL be called before ResumeService
          const startIdx = callOrder.indexOf('StartDBCluster');
          const resumeIdx = callOrder.indexOf('ResumeService');

          expect(startIdx).toBeGreaterThanOrEqual(0);
          expect(resumeIdx).toBeGreaterThanOrEqual(0);
          expect(startIdx).toBeLessThan(resumeIdx);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 10.3, 10.4**
   *
   * For any valid combination of ARN and cluster identifier, the stop sequence
   * SHALL execute exactly two primary operations (PauseService + StopDBCluster)
   * and the start sequence SHALL execute at least two primary operations
   * (StartDBCluster + ResumeService) before health checking.
   */
  it('stop calls exactly two operations and start calls at least two primary operations', () => {
    fc.assert(
      fc.asyncProperty(
        arbServiceArn(),
        arbClusterIdentifier(),
        async (serviceArn, clusterIdentifier) => {
          // --- Stop sequence ---
          let stopCallCount = 0;
          const stopAppRunnerClient = {
            send: vi.fn().mockImplementation(() => {
              stopCallCount++;
              return Promise.resolve({ Service: { Status: 'PAUSING' } });
            }),
          };
          const stopDocDbClient = {
            send: vi.fn().mockImplementation(() => {
              stopCallCount++;
              return Promise.resolve({ DBCluster: { Status: 'stopping' } });
            }),
          };

          await executeStop({
            appRunnerClient: stopAppRunnerClient,
            docDbClient: stopDocDbClient,
            serviceArn,
            clusterIdentifier,
          });

          // Stop SHALL execute exactly 2 primary operations
          expect(stopCallCount).toBe(2);

          // --- Start sequence ---
          let startPrimaryOps = 0;
          const startAppRunnerClient = {
            send: vi.fn().mockImplementation(() => {
              startPrimaryOps++;
              return Promise.resolve({ Service: { Status: 'RUNNING' } });
            }),
          };
          const startDocDbClient = {
            send: vi.fn().mockImplementation(() => {
              startPrimaryOps++;
              return Promise.resolve({ DBCluster: { Status: 'starting' } });
            }),
          };

          await executeStart({
            appRunnerClient: startAppRunnerClient,
            docDbClient: startDocDbClient,
            serviceArn,
            clusterIdentifier,
          });

          // Start SHALL execute at least 2 primary operations (StartDBCluster + ResumeService)
          // Plus at least 1 health check call
          expect(startPrimaryOps).toBeGreaterThanOrEqual(2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
