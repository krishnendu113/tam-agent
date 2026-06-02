/**
 * Unit tests for src/tools/planTools.js — create_plan, update_plan_task, read_plan tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlanTool, updatePlanTaskTool, readPlanTool } from '../tools/planTools.js';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PLANS_DIR = resolve(process.cwd(), 'plans');

describe('planTools', () => {
  beforeEach(() => {
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(PLANS_DIR)) {
      rmSync(PLANS_DIR, { recursive: true, force: true });
    }
  });

  describe('createPlanTool', () => {
    it('has correct tool metadata', () => {
      expect(createPlanTool.name).toBe('create_plan');
      expect(createPlanTool.tags).toEqual(['plan']);
      expect(createPlanTool.inputSchema.required).toContain('title');
      expect(createPlanTool.inputSchema.required).toContain('tasks');
      expect(createPlanTool.inputSchema.properties.tasks.maxItems).toBe(15);
    });

    it('creates a plan with valid inputs', async () => {
      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: 'Test Plan',
        tasks: [
          { id: '1', description: 'First task' },
          { id: '2', description: 'Second task', critical: true }
        ]
      });

      expect(result.error).toBeUndefined();
      expect(result.planId).toMatch(/^sess-1_\d+$/);
      expect(result.title).toBe('Test Plan');
      expect(result.taskCount).toBe(2);
      expect(result.createdAt).toBeDefined();
    });

    it('generates a sessionId when not provided', async () => {
      const result = await createPlanTool.handler({
        title: 'No Session Plan',
        tasks: [{ id: '1', description: 'Task' }]
      });

      expect(result.error).toBeUndefined();
      expect(result.planId).toMatch(/^session_\d+_\d+$/);
      expect(result.title).toBe('No Session Plan');
    });

    it('returns error when title is empty', async () => {
      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: '',
        tasks: [{ id: '1', description: 'Task' }]
      });

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/title/i);
    });

    it('returns error when title is not a string', async () => {
      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: 123,
        tasks: [{ id: '1', description: 'Task' }]
      });

      expect(result.error).toBeTruthy();
    });

    it('returns error when tasks is empty array', async () => {
      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: 'Empty Tasks',
        tasks: []
      });

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/tasks/i);
    });

    it('returns error when tasks is not an array', async () => {
      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: 'Bad Tasks',
        tasks: 'not-an-array'
      });

      expect(result.error).toBeTruthy();
    });

    it('returns error when tasks exceed 15', async () => {
      const tasks = Array.from({ length: 16 }, (_, i) => ({
        id: String(i + 1),
        description: `Task ${i + 1}`
      }));

      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: 'Too Many Tasks',
        tasks
      });

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/15/);
    });

    it('allows exactly 15 tasks', async () => {
      const tasks = Array.from({ length: 15 }, (_, i) => ({
        id: String(i + 1),
        description: `Task ${i + 1}`
      }));

      const result = await createPlanTool.handler({
        sessionId: 'sess-1',
        title: 'Max Tasks',
        tasks
      });

      expect(result.error).toBeUndefined();
      expect(result.taskCount).toBe(15);
    });
  });

  describe('updatePlanTaskTool', () => {
    it('has correct tool metadata', () => {
      expect(updatePlanTaskTool.name).toBe('update_plan_task');
      expect(updatePlanTaskTool.tags).toEqual(['plan']);
      expect(updatePlanTaskTool.inputSchema.required).toContain('planId');
      expect(updatePlanTaskTool.inputSchema.required).toContain('taskId');
      expect(updatePlanTaskTool.inputSchema.required).toContain('status');
      expect(updatePlanTaskTool.inputSchema.properties.status.enum).toEqual([
        'in_progress', 'complete', 'failed'
      ]);
    });

    it('updates a task status to complete with result', async () => {
      const created = await createPlanTool.handler({
        sessionId: 'sess-upd',
        title: 'Update Plan',
        tasks: [
          { id: '1', description: 'Task A' },
          { id: '2', description: 'Task B' }
        ]
      });

      const result = await updatePlanTaskTool.handler({
        planId: created.planId,
        taskId: '1',
        status: 'complete',
        result: 'Done successfully'
      });

      expect(result.error).toBeUndefined();
      expect(result.planId).toBe(created.planId);
      expect(result.tasks[0].status).toBe('complete');
      expect(result.tasks[0].result).toBe('Done successfully');
      expect(result.tasks[1].status).toBe('pending');
    });

    it('updates a task status to in_progress', async () => {
      const created = await createPlanTool.handler({
        sessionId: 'sess-ip',
        title: 'IP Plan',
        tasks: [{ id: '1', description: 'Task A' }]
      });

      const result = await updatePlanTaskTool.handler({
        planId: created.planId,
        taskId: '1',
        status: 'in_progress'
      });

      expect(result.error).toBeUndefined();
      expect(result.tasks[0].status).toBe('in_progress');
    });

    it('updates a task status to failed', async () => {
      const created = await createPlanTool.handler({
        sessionId: 'sess-fail',
        title: 'Fail Plan',
        tasks: [{ id: '1', description: 'Task A' }]
      });

      const result = await updatePlanTaskTool.handler({
        planId: created.planId,
        taskId: '1',
        status: 'failed',
        result: 'Timeout error'
      });

      expect(result.error).toBeUndefined();
      expect(result.tasks[0].status).toBe('failed');
      expect(result.tasks[0].result).toBe('Timeout error');
    });

    it('returns error for non-existent plan', async () => {
      const result = await updatePlanTaskTool.handler({
        planId: 'nonexistent_123',
        taskId: '1',
        status: 'complete'
      });

      expect(result.error).toMatch(/Plan not found/);
    });

    it('returns error for non-existent task', async () => {
      const created = await createPlanTool.handler({
        sessionId: 'sess-notask',
        title: 'No Task Plan',
        tasks: [{ id: '1', description: 'Only task' }]
      });

      const result = await updatePlanTaskTool.handler({
        planId: created.planId,
        taskId: '99',
        status: 'complete'
      });

      expect(result.error).toMatch(/Task not found/);
    });

    it('returns error for invalid status', async () => {
      const result = await updatePlanTaskTool.handler({
        planId: 'some-plan',
        taskId: '1',
        status: 'invalid'
      });

      expect(result.error).toMatch(/status must be one of/);
    });

    it('returns error when planId is empty', async () => {
      const result = await updatePlanTaskTool.handler({
        planId: '',
        taskId: '1',
        status: 'complete'
      });

      expect(result.error).toBeTruthy();
    });

    it('returns error when taskId is empty', async () => {
      const result = await updatePlanTaskTool.handler({
        planId: 'some-plan',
        taskId: '',
        status: 'complete'
      });

      expect(result.error).toBeTruthy();
    });
  });

  describe('readPlanTool', () => {
    it('has correct tool metadata', () => {
      expect(readPlanTool.name).toBe('read_plan');
      expect(readPlanTool.tags).toEqual(['plan']);
      expect(readPlanTool.inputSchema.required).toContain('planId');
    });

    it('reads a plan with all task data', async () => {
      const created = await createPlanTool.handler({
        sessionId: 'sess-read',
        title: 'Read Plan',
        tasks: [
          { id: '1', description: 'Task A', critical: true },
          { id: '2', description: 'Task B' }
        ]
      });

      const result = await readPlanTool.handler({ planId: created.planId });

      expect(result.error).toBeUndefined();
      expect(result.planId).toBe(created.planId);
      expect(result.title).toBe('Read Plan');
      expect(result.sessionId).toBe('sess-read');
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].id).toBe('1');
      expect(result.tasks[0].description).toBe('Task A');
      expect(result.tasks[0].critical).toBe(true);
      expect(result.tasks[0].status).toBe('pending');
      expect(result.tasks[1].id).toBe('2');
      expect(result.tasks[1].critical).toBe(false);
    });

    it('reads a plan after task updates', async () => {
      const created = await createPlanTool.handler({
        sessionId: 'sess-updated',
        title: 'Updated Plan',
        tasks: [
          { id: '1', description: 'Task A' },
          { id: '2', description: 'Task B' }
        ]
      });

      await updatePlanTaskTool.handler({
        planId: created.planId,
        taskId: '1',
        status: 'complete',
        result: 'All good'
      });

      const result = await readPlanTool.handler({ planId: created.planId });

      expect(result.tasks[0].status).toBe('complete');
      expect(result.tasks[0].result).toBe('All good');
      expect(result.tasks[1].status).toBe('pending');
    });

    it('returns error for non-existent plan', async () => {
      const result = await readPlanTool.handler({ planId: 'nonexistent_999' });

      expect(result.error).toMatch(/Plan not found/);
    });

    it('returns error when planId is empty', async () => {
      const result = await readPlanTool.handler({ planId: '' });

      expect(result.error).toBeTruthy();
    });

    it('returns error when planId is not a string', async () => {
      const result = await readPlanTool.handler({ planId: 123 });

      expect(result.error).toBeTruthy();
    });
  });
});
