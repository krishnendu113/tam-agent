/**
 * Property-based tests for plan task update isolation
 *
 * Property 7: Plan Task Update Preserves Other Tasks
 *
 * For any plan with N tasks (1 ≤ N ≤ 15), updating a single task K's status
 * and result SHALL leave all other N-1 tasks with their original status,
 * description, and result values unchanged.
 *
 * **Validates: Requirements 4.4**
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createPlan, updatePlanTask, readPlan } from '../planManager.js';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLANS_DIR = resolve(process.cwd(), 'plans');

describe('Feature: skill-system-enhancement, Property 7: Plan Task Update Preserves Other Tasks', () => {
  afterEach(() => {
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  // --- Generators ---

  /**
   * Generates a valid task description (alphanumeric with spaces, no pipe characters
   * which would interfere with the plan markdown format).
   */
  function arbTaskDescription() {
    return fc.stringMatching(/^[A-Za-z0-9 ]{1,40}$/).filter((s) => s.trim().length > 0);
  }

  /**
   * Generates a valid task ID (alphanumeric, short).
   */
  function arbTaskId() {
    return fc.stringMatching(/^[a-z0-9]{1,8}$/).filter((s) => s.length > 0);
  }

  /**
   * Generates a valid plan title (alphanumeric with spaces, no pipes).
   */
  function arbPlanTitle() {
    return fc.stringMatching(/^[A-Za-z0-9 ]{1,30}$/).filter((s) => s.trim().length > 0);
  }

  /**
   * Generates a valid session ID.
   */
  function arbSessionId() {
    return fc.stringMatching(/^[a-z0-9]{4,12}$/);
  }

  /**
   * Generates an array of 2-15 tasks with unique IDs.
   */
  function arbTaskArray() {
    return fc
      .integer({ min: 2, max: 15 })
      .chain((n) =>
        fc.tuple(
          fc.array(arbTaskDescription(), { minLength: n, maxLength: n }),
          fc.array(fc.boolean(), { minLength: n, maxLength: n })
        ).map(([descriptions, criticals]) =>
          descriptions.map((desc, i) => ({
            id: String(i + 1),
            description: desc,
            critical: criticals[i],
          }))
        )
      );
  }

  /**
   * Generates a valid status for updatePlanTask.
   */
  function arbStatus() {
    return fc.constantFrom('in_progress', 'complete', 'failed');
  }

  /**
   * Generates an optional result string (alphanumeric with spaces, no pipes).
   */
  function arbResult() {
    return fc.option(
      fc.stringMatching(/^[A-Za-z0-9 ]{1,50}$/).filter((s) => s.trim().length > 0),
      { nil: undefined }
    );
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 4.4**
   *
   * For any plan with N tasks, updating a single task K SHALL leave all other
   * N-1 tasks with their original status, description, and result values unchanged.
   */
  it('updating a single task preserves all other tasks unchanged', () => {
    fc.assert(
      fc.property(
        arbSessionId(),
        arbPlanTitle(),
        arbTaskArray(),
        arbStatus(),
        arbResult(),
        (sessionId, title, tasks, newStatus, newResult) => {
          // Create a plan with N tasks
          const plan = createPlan(sessionId, title, tasks);

          // Pick a random task index to update (using the task count)
          const taskIndex = Math.floor(Math.random() * tasks.length);
          const targetTaskId = plan.tasks[taskIndex].id;

          // Capture the state of all tasks before the update
          const beforePlan = readPlan(plan.planId);
          const tasksBefore = beforePlan.tasks.map((t) => ({
            id: t.id,
            description: t.description,
            status: t.status,
            result: t.result,
            critical: t.critical,
          }));

          // Update a single task
          updatePlanTask(plan.planId, targetTaskId, newStatus, newResult);

          // Read the plan after the update
          const afterPlan = readPlan(plan.planId);

          // Verify all OTHER tasks (N-1) are unchanged
          for (let i = 0; i < afterPlan.tasks.length; i++) {
            if (afterPlan.tasks[i].id === targetTaskId) {
              // The updated task should have the new status
              expect(afterPlan.tasks[i].status).toBe(newStatus);
              continue;
            }

            // All other tasks must be unchanged
            const original = tasksBefore[i];
            const current = afterPlan.tasks[i];

            expect(current.id).toBe(original.id);
            expect(current.description).toBe(original.description);
            expect(current.status).toBe(original.status);
            expect(current.result).toBe(original.result);
            expect(current.critical).toBe(original.critical);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.4**
   *
   * For any plan with N tasks, applying multiple sequential updates to a single
   * task SHALL still leave all other N-1 tasks unchanged from their original state.
   */
  it('multiple sequential updates to the same task preserve all other tasks', () => {
    fc.assert(
      fc.property(
        arbSessionId(),
        arbPlanTitle(),
        arbTaskArray(),
        fc.array(fc.tuple(arbStatus(), arbResult()), { minLength: 2, maxLength: 4 }),
        (sessionId, title, tasks, updates) => {
          const plan = createPlan(sessionId, title, tasks);

          // Pick a single task to update multiple times
          const taskIndex = Math.floor(Math.random() * tasks.length);
          const targetTaskId = plan.tasks[taskIndex].id;

          // Capture initial state of other tasks
          const beforePlan = readPlan(plan.planId);
          const otherTasksBefore = beforePlan.tasks
            .filter((t) => t.id !== targetTaskId)
            .map((t) => ({
              id: t.id,
              description: t.description,
              status: t.status,
              result: t.result,
              critical: t.critical,
            }));

          // Apply multiple sequential updates to the same task
          for (const [status, result] of updates) {
            updatePlanTask(plan.planId, targetTaskId, status, result);
          }

          // Read the plan after all updates
          const afterPlan = readPlan(plan.planId);
          const otherTasksAfter = afterPlan.tasks.filter(
            (t) => t.id !== targetTaskId
          );

          // All other tasks must remain unchanged
          expect(otherTasksAfter.length).toBe(otherTasksBefore.length);
          for (let i = 0; i < otherTasksAfter.length; i++) {
            expect(otherTasksAfter[i].id).toBe(otherTasksBefore[i].id);
            expect(otherTasksAfter[i].description).toBe(otherTasksBefore[i].description);
            expect(otherTasksAfter[i].status).toBe(otherTasksBefore[i].status);
            expect(otherTasksAfter[i].result).toBe(otherTasksBefore[i].result);
            expect(otherTasksAfter[i].critical).toBe(otherTasksBefore[i].critical);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * **Validates: Requirements 4.4**
   *
   * For any plan, updating task K does not change the total number of tasks.
   */
  it('updating a task never changes the total task count', () => {
    fc.assert(
      fc.property(
        arbSessionId(),
        arbPlanTitle(),
        arbTaskArray(),
        arbStatus(),
        arbResult(),
        (sessionId, title, tasks, newStatus, newResult) => {
          const plan = createPlan(sessionId, title, tasks);
          const originalCount = plan.tasks.length;

          // Pick a random task to update
          const targetTaskId = plan.tasks[Math.floor(Math.random() * tasks.length)].id;

          updatePlanTask(plan.planId, targetTaskId, newStatus, newResult);

          const afterPlan = readPlan(plan.planId);
          expect(afterPlan.tasks.length).toBe(originalCount);
        }
      ),
      { numRuns: 100 }
    );
  });
});
