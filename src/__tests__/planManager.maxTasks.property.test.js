import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createPlan } from '../planManager.js';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLANS_DIR = resolve(process.cwd(), 'plans');

// --- Generators ---

/**
 * Generates a valid plan task object with id and description.
 */
function arbTask() {
  return fc.record({
    id: fc.stringMatching(/^[a-z0-9]{1,10}$/),
    description: fc.string({ minLength: 1, maxLength: 100 }),
    critical: fc.boolean(),
  });
}

/**
 * Generates a task array with more than 15 elements (16-30).
 */
function arbOverLimitTasks() {
  return fc.array(arbTask(), { minLength: 16, maxLength: 30 });
}

/**
 * Generates a task array with 1-15 elements (valid range).
 */
function arbValidTasks() {
  return fc.array(arbTask(), { minLength: 1, maxLength: 15 });
}

/**
 * Generates a valid non-empty session ID.
 */
function arbSessionId() {
  return fc.stringMatching(/^[a-z0-9-]{3,20}$/);
}

/**
 * Generates a valid non-empty plan title.
 */
function arbTitle() {
  return fc.string({ minLength: 1, maxLength: 80 });
}

// --- Property Tests ---

describe('Property 8: Plan Maximum Task Limit Enforcement', () => {
  afterEach(() => {
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  /**
   * **Validates: Requirements 4.7**
   *
   * For any task array with more than 15 elements, invoking create_plan
   * SHALL reject the input with an error.
   */
  it('create_plan rejects task arrays with more than 15 elements', () => {
    fc.assert(
      fc.property(arbSessionId(), arbTitle(), arbOverLimitTasks(), (sessionId, title, tasks) => {
        expect(() => createPlan(sessionId, title, tasks)).toThrow(/cannot exceed 15 tasks/);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.7**
   *
   * For any task array with 1-15 elements, invoking create_plan
   * SHALL succeed and return a valid plan object.
   */
  it('create_plan succeeds for task arrays with 1-15 elements', () => {
    fc.assert(
      fc.property(arbSessionId(), arbTitle(), arbValidTasks(), (sessionId, title, tasks) => {
        const plan = createPlan(sessionId, title, tasks);

        expect(plan).toBeDefined();
        expect(plan.planId).toContain(sessionId);
        expect(plan.title).toBe(title);
        expect(plan.tasks).toHaveLength(tasks.length);
      }),
      { numRuns: 100 }
    );
  });
});
