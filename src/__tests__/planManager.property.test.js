/**
 * Property-based tests for src/planManager.js — Plan File Serialization Round-Trip
 *
 * Property 6: Plan File Serialization Round-Trip
 *
 * For any valid plan with title and 1-15 tasks, creating via create_plan and
 * reading via read_plan SHALL produce identical title, task count, ids,
 * descriptions, and critical flags.
 *
 * **Validates: Requirements 4.2, 4.5**
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createPlan, readPlan } from '../planManager.js';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLANS_DIR = resolve(process.cwd(), 'plans');

describe('Feature: skill-system-enhancement, Property 6: Plan File Serialization Round-Trip', () => {
  afterEach(() => {
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  // --- Generators ---

  /**
   * Generates a non-empty plan title string.
   * Avoids characters that would break the markdown parsing:
   * - No newlines (title is a single line in `# Plan: {title}`)
   * - No pipe characters (used as field delimiters in task lines)
   */
  function arbTitle() {
    return fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9 ,.\-_!?()]{0,79}$/)
      .filter((s) => s.trim().length > 0);
  }

  /**
   * Generates a valid task id.
   * Uses simple alphanumeric strings with dots (e.g., "1", "2.1", "task-3").
   * Avoids pipe characters and markdown bold markers.
   */
  function arbTaskId() {
    return fc
      .stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9.\-_]{0,9}$/)
      .filter((s) => s.length > 0 && !s.includes('**'));
  }

  /**
   * Generates a task description string.
   * Avoids pipe characters (field delimiter), newlines, and `**` (bold markers).
   */
  function arbTaskDescription() {
    return fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9 ,.\-_!?()]{0,99}$/)
      .filter((s) => s.trim().length > 0 && !s.includes('|') && !s.includes('**'));
  }

  /**
   * Generates a single plan task object with id, description, and optional critical flag.
   */
  function arbTask() {
    return fc.record({
      id: arbTaskId(),
      description: arbTaskDescription(),
      critical: fc.boolean(),
    });
  }

  /**
   * Generates an array of 1-15 tasks with unique ids.
   */
  function arbTasks() {
    return fc
      .array(arbTask(), { minLength: 1, maxLength: 15 })
      .map((tasks) => {
        // Ensure unique IDs by appending index suffix if duplicates exist
        const seen = new Set();
        return tasks.map((t, i) => {
          let id = t.id;
          if (seen.has(id)) {
            id = `${id}_${i}`;
          }
          seen.add(id);
          return { ...t, id };
        });
      });
  }

  /**
   * Generates a valid session ID string.
   */
  function arbSessionId() {
    return fc
      .stringMatching(/^[a-zA-Z][a-zA-Z0-9\-_]{2,19}$/)
      .filter((s) => s.length >= 3);
  }

  // --- Property Tests ---

  /**
   * **Validates: Requirements 4.2, 4.5**
   *
   * For any valid plan with title and 1-15 tasks, creating via createPlan and
   * reading via readPlan SHALL produce a plan object with the same title,
   * same number of tasks, and each task having the same id, description,
   * and critical flag as the original input.
   */
  it('createPlan → readPlan round-trip preserves title, task count, ids, descriptions, and critical flags', () => {
    fc.assert(
      fc.property(
        arbSessionId(),
        arbTitle(),
        arbTasks(),
        (sessionId, title, tasks) => {
          // Create the plan
          const created = createPlan(sessionId, title, tasks);

          // Read it back from disk
          const read = readPlan(created.planId);

          // Title SHALL be identical
          expect(read.title).toBe(title);

          // Task count SHALL be identical
          expect(read.tasks.length).toBe(tasks.length);

          // Each task SHALL have the same id, description, and critical flag
          for (let i = 0; i < tasks.length; i++) {
            expect(read.tasks[i].id).toBe(tasks[i].id);
            expect(read.tasks[i].description).toBe(tasks[i].description);
            expect(read.tasks[i].critical).toBe(Boolean(tasks[i].critical));
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.2, 4.5**
   *
   * All tasks in a newly created plan SHALL have status "pending" when read back,
   * confirming the initial state is correctly serialized.
   */
  it('createPlan → readPlan round-trip sets all task statuses to pending', () => {
    fc.assert(
      fc.property(
        arbSessionId(),
        arbTitle(),
        arbTasks(),
        (sessionId, title, tasks) => {
          const created = createPlan(sessionId, title, tasks);
          const read = readPlan(created.planId);

          for (const task of read.tasks) {
            expect(task.status).toBe('pending');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 4.2, 4.5**
   *
   * The planId and sessionId SHALL be preserved through the round-trip,
   * ensuring the plan can be identified and associated with its session.
   */
  it('createPlan → readPlan round-trip preserves planId and sessionId', () => {
    fc.assert(
      fc.property(
        arbSessionId(),
        arbTitle(),
        arbTasks(),
        (sessionId, title, tasks) => {
          const created = createPlan(sessionId, title, tasks);
          const read = readPlan(created.planId);

          expect(read.planId).toBe(created.planId);
          expect(read.sessionId).toBe(sessionId);
        }
      ),
      { numRuns: 100 }
    );
  });
});
