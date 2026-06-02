import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlan, updatePlanTask, readPlan, listSessionPlans } from '../planManager.js';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PLANS_DIR = resolve(process.cwd(), 'plans');

describe('src/planManager.js - Plan CRUD Operations', () => {
  beforeEach(() => {
    // Clean the plans directory before each test
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  describe('createPlan', () => {
    it('creates a plan file with correct structure', () => {
      const tasks = [
        { id: '1', description: 'Research topic', critical: true },
        { id: '2', description: 'Write draft', critical: false },
      ];

      const plan = createPlan('session-abc', 'My Plan', tasks);

      expect(plan.planId).toMatch(/^session-abc_\d+$/);
      expect(plan.sessionId).toBe('session-abc');
      expect(plan.title).toBe('My Plan');
      expect(plan.createdAt).toBeDefined();
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0].id).toBe('1');
      expect(plan.tasks[0].description).toBe('Research topic');
      expect(plan.tasks[0].critical).toBe(true);
      expect(plan.tasks[0].status).toBe('pending');
      expect(plan.tasks[1].critical).toBe(false);
    });

    it('creates the plans/ directory if it does not exist', () => {
      expect(existsSync(PLANS_DIR)).toBe(false);

      createPlan('sess-1', 'Test Plan', [{ id: '1', description: 'Task 1' }]);

      expect(existsSync(PLANS_DIR)).toBe(true);
    });

    it('writes a .md file to plans/ directory', () => {
      const plan = createPlan('sess-1', 'File Plan', [
        { id: '1', description: 'Do thing' },
      ]);

      const filePath = resolve(PLANS_DIR, `${plan.planId}.md`);
      expect(existsSync(filePath)).toBe(true);
    });

    it('defaults critical to false when not specified', () => {
      const plan = createPlan('sess-1', 'Plan', [
        { id: '1', description: 'Task without critical' },
      ]);

      expect(plan.tasks[0].critical).toBe(false);
    });

    it('rejects plans with more than 15 tasks', () => {
      const tasks = Array.from({ length: 16 }, (_, i) => ({
        id: String(i + 1),
        description: `Task ${i + 1}`,
      }));

      expect(() => createPlan('sess-1', 'Big Plan', tasks)).toThrow(
        /cannot exceed 15 tasks/
      );
    });

    it('allows exactly 15 tasks', () => {
      const tasks = Array.from({ length: 15 }, (_, i) => ({
        id: String(i + 1),
        description: `Task ${i + 1}`,
      }));

      const plan = createPlan('sess-1', 'Max Plan', tasks);
      expect(plan.tasks).toHaveLength(15);
    });

    it('rejects empty title', () => {
      expect(() => createPlan('sess-1', '', [{ id: '1', description: 'x' }])).toThrow();
    });

    it('rejects empty tasks array', () => {
      expect(() => createPlan('sess-1', 'Empty', [])).toThrow();
    });

    it('rejects missing sessionId', () => {
      expect(() => createPlan('', 'Plan', [{ id: '1', description: 'x' }])).toThrow();
    });
  });

  describe('readPlan', () => {
    it('reads a plan back with correct data', () => {
      const tasks = [
        { id: '1', description: 'Research topic', critical: true },
        { id: '2', description: 'Write draft', critical: false },
      ];
      const created = createPlan('sess-read', 'Read Test', tasks);

      const read = readPlan(created.planId);

      expect(read.planId).toBe(created.planId);
      expect(read.sessionId).toBe('sess-read');
      expect(read.title).toBe('Read Test');
      expect(read.createdAt).toBe(created.createdAt);
      expect(read.tasks).toHaveLength(2);
      expect(read.tasks[0].id).toBe('1');
      expect(read.tasks[0].description).toBe('Research topic');
      expect(read.tasks[0].status).toBe('pending');
      expect(read.tasks[1].id).toBe('2');
      expect(read.tasks[1].description).toBe('Write draft');
    });

    it('preserves the critical flag through round-trip', () => {
      const tasks = [
        { id: '1', description: 'Critical task', critical: true },
        { id: '2', description: 'Normal task', critical: false },
        { id: '3', description: 'Default task' },
      ];
      const created = createPlan('sess-crit', 'Critical Plan', tasks);
      const read = readPlan(created.planId);

      expect(read.tasks[0].critical).toBe(true);
      expect(read.tasks[1].critical).toBe(false);
      expect(read.tasks[2].critical).toBe(false);
    });

    it('throws for non-existent plan', () => {
      mkdirSync(PLANS_DIR, { recursive: true });
      expect(() => readPlan('nonexistent_123')).toThrow(/Plan not found/);
    });
  });

  describe('updatePlanTask', () => {
    it('updates a task status to complete', () => {
      const plan = createPlan('sess-update', 'Update Test', [
        { id: '1', description: 'Task A' },
        { id: '2', description: 'Task B' },
      ]);

      const updated = updatePlanTask(plan.planId, '1', 'complete', 'Done successfully');

      expect(updated.tasks[0].status).toBe('complete');
      expect(updated.tasks[0].result).toBe('Done successfully');
      expect(updated.tasks[1].status).toBe('pending');
    });

    it('updates a task status to in_progress', () => {
      const plan = createPlan('sess-ip', 'IP Test', [
        { id: '1', description: 'Task A' },
      ]);

      const updated = updatePlanTask(plan.planId, '1', 'in_progress');
      expect(updated.tasks[0].status).toBe('in_progress');
    });

    it('updates a task status to failed with error result', () => {
      const plan = createPlan('sess-fail', 'Fail Test', [
        { id: '1', description: 'Task A' },
      ]);

      const updated = updatePlanTask(plan.planId, '1', 'failed', 'Connection timeout');

      expect(updated.tasks[0].status).toBe('failed');
      expect(updated.tasks[0].result).toBe('Connection timeout');
    });

    it('persists the update to disk', () => {
      const plan = createPlan('sess-persist', 'Persist Test', [
        { id: '1', description: 'Task A' },
        { id: '2', description: 'Task B' },
      ]);

      updatePlanTask(plan.planId, '1', 'complete', 'Result text');

      // Read back from disk
      const read = readPlan(plan.planId);
      expect(read.tasks[0].status).toBe('complete');
      expect(read.tasks[0].result).toBe('Result text');
      expect(read.tasks[1].status).toBe('pending');
    });

    it('preserves other tasks when updating one', () => {
      const plan = createPlan('sess-iso', 'Isolation Test', [
        { id: '1', description: 'First task' },
        { id: '2', description: 'Second task' },
        { id: '3', description: 'Third task' },
      ]);

      updatePlanTask(plan.planId, '2', 'complete', 'Done');

      const read = readPlan(plan.planId);
      expect(read.tasks[0].status).toBe('pending');
      expect(read.tasks[0].description).toBe('First task');
      expect(read.tasks[1].status).toBe('complete');
      expect(read.tasks[1].result).toBe('Done');
      expect(read.tasks[2].status).toBe('pending');
      expect(read.tasks[2].description).toBe('Third task');
    });

    it('throws for non-existent plan', () => {
      mkdirSync(PLANS_DIR, { recursive: true });
      expect(() => updatePlanTask('noplan_123', '1', 'complete')).toThrow(/Plan not found/);
    });

    it('throws for non-existent task', () => {
      const plan = createPlan('sess-notask', 'No Task Test', [
        { id: '1', description: 'Only task' },
      ]);

      expect(() => updatePlanTask(plan.planId, '99', 'complete')).toThrow(/Task not found/);
    });

    it('throws for invalid status', () => {
      const plan = createPlan('sess-badstat', 'Bad Status Test', [
        { id: '1', description: 'Task' },
      ]);

      expect(() => updatePlanTask(plan.planId, '1', 'invalid_status')).toThrow(/Invalid status/);
    });
  });

  describe('listSessionPlans', () => {
    it('returns empty array when no plans exist for session', () => {
      const plans = listSessionPlans('empty-session');
      expect(plans).toEqual([]);
    });

    it('returns plans for the specified session only', async () => {
      createPlan('sess-A', 'Plan A1', [{ id: '1', description: 'Task' }]);
      // Small delay to ensure unique timestamp
      await new Promise((r) => setTimeout(r, 5));
      createPlan('sess-A', 'Plan A2', [{ id: '1', description: 'Task' }]);
      createPlan('sess-B', 'Plan B1', [{ id: '1', description: 'Task' }]);

      const plansA = listSessionPlans('sess-A');
      const plansB = listSessionPlans('sess-B');

      expect(plansA).toHaveLength(2);
      expect(plansB).toHaveLength(1);
      expect(plansB[0].title).toBe('Plan B1');
    });

    it('returns correct summary fields', () => {
      const plan = createPlan('sess-sum', 'Summary Plan', [
        { id: '1', description: 'Task 1' },
        { id: '2', description: 'Task 2' },
        { id: '3', description: 'Task 3' },
      ]);

      updatePlanTask(plan.planId, '1', 'complete', 'Done');

      const summaries = listSessionPlans('sess-sum');
      expect(summaries).toHaveLength(1);
      expect(summaries[0].planId).toBe(plan.planId);
      expect(summaries[0].title).toBe('Summary Plan');
      expect(summaries[0].createdAt).toBeDefined();
      expect(summaries[0].taskCount).toBe(3);
      expect(summaries[0].completedCount).toBe(1);
    });

    it('does not return plans from sessions with similar prefix', () => {
      createPlan('sess', 'Plan 1', [{ id: '1', description: 'Task' }]);
      createPlan('sess-extended', 'Plan 2', [{ id: '1', description: 'Task' }]);

      const plans = listSessionPlans('sess');
      expect(plans).toHaveLength(1);
      expect(plans[0].title).toBe('Plan 1');
    });
  });
});
