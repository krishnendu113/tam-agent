// Plan tools - create, update, and read execution plans via planManager.

import { createPlan, updatePlanTask, readPlan } from '../planManager.js';

/**
 * Tool: create_plan
 *
 * Creates a structured execution plan with tasks. Use for complex queries
 * requiring multiple steps.
 */
export const createPlanTool = {
  name: 'create_plan',
  description: 'Create a structured execution plan with tasks. Use for complex queries requiring multiple steps.',
  tags: ['plan'],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session identifier for the plan'
      },
      title: {
        type: 'string',
        description: 'Plan title describing the goal'
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            critical: {
              type: 'boolean',
              description: 'If true, plan halts on failure'
            }
          },
          required: ['id', 'description']
        },
        maxItems: 15
      }
    },
    required: ['title', 'tasks']
  },
  async handler(input) {
    const { sessionId, title, tasks } = input;

    if (!title || typeof title !== 'string') {
      return { error: 'title is required and must be a non-empty string.' };
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { error: 'tasks is required and must be a non-empty array.' };
    }

    if (tasks.length > 15) {
      return { error: 'Plan cannot exceed 15 tasks.' };
    }

    // sessionId is optional in the schema but required by planManager;
    // generate a fallback if not provided.
    const resolvedSessionId = (sessionId && typeof sessionId === 'string')
      ? sessionId
      : `session_${Date.now()}`;

    try {
      const plan = createPlan(resolvedSessionId, title, tasks);
      return { planId: plan.planId, title: plan.title, taskCount: plan.tasks.length, createdAt: plan.createdAt };
    } catch (err) {
      return { error: err.message };
    }
  }
};

/**
 * Tool: update_plan_task
 *
 * Updates a task's status and result in an existing plan.
 */
export const updatePlanTaskTool = {
  name: 'update_plan_task',
  description: "Update a task's status and result in an existing plan.",
  tags: ['plan'],
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string' },
      taskId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['in_progress', 'complete', 'failed']
      },
      result: {
        type: 'string',
        description: 'Output or error from the task'
      }
    },
    required: ['planId', 'taskId', 'status']
  },
  async handler(input) {
    const { planId, taskId, status, result } = input;

    if (!planId || typeof planId !== 'string') {
      return { error: 'planId is required and must be a non-empty string.' };
    }

    if (!taskId || typeof taskId !== 'string') {
      return { error: 'taskId is required and must be a non-empty string.' };
    }

    const validStatuses = ['in_progress', 'complete', 'failed'];
    if (!validStatuses.includes(status)) {
      return { error: `status must be one of: ${validStatuses.join(', ')}` };
    }

    try {
      const plan = updatePlanTask(planId, taskId, status, result);
      return { planId: plan.planId, title: plan.title, tasks: plan.tasks };
    } catch (err) {
      return { error: err.message };
    }
  }
};

/**
 * Tool: read_plan
 *
 * Reads the current state of an execution plan including all task statuses
 * and results.
 */
export const readPlanTool = {
  name: 'read_plan',
  description: 'Read the current state of an execution plan including all task statuses and results.',
  tags: ['plan'],
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string' }
    },
    required: ['planId']
  },
  async handler(input) {
    const { planId } = input;

    if (!planId || typeof planId !== 'string') {
      return { error: 'planId is required and must be a non-empty string.' };
    }

    try {
      const plan = readPlan(planId);
      return plan;
    } catch (err) {
      return { error: err.message };
    }
  }
};

export default { createPlanTool, updatePlanTaskTool, readPlanTool };
