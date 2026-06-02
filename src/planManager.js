/**
 * Plan Manager - CRUD operations on plan .md files in the plans/ directory.
 *
 * Plan files are persistent markdown artifacts on disk that the LLM manages
 * via dedicated tools (create_plan, update_plan_task, read_plan).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_TASKS = 15;
const PLANS_DIR = resolve(process.cwd(), 'plans');

/**
 * Ensures the plans/ directory exists.
 */
function ensurePlansDir() {
  if (!existsSync(PLANS_DIR)) {
    mkdirSync(PLANS_DIR, { recursive: true });
  }
}

/**
 * Serializes a plan to markdown format.
 * @param {object} plan - PlanFile object
 * @returns {string} Markdown string
 */
function serializePlan(plan) {
  const lines = [];
  lines.push(`# Plan: ${plan.title}`);
  lines.push(`<!-- planId: ${plan.planId} | sessionId: ${plan.sessionId} | created: ${plan.createdAt} -->`);
  lines.push('');
  lines.push('## Tasks');
  lines.push('');

  for (const task of plan.tasks) {
    const checkbox = task.status === 'complete' ? '[x]' : '[ ]';
    const criticalFlag = task.critical ? ' | critical: true' : '';
    let line = `- ${checkbox} **${task.id}** | ${task.description} | status: ${task.status}${criticalFlag}`;
    if (task.result) {
      line += ` | result: ${task.result}`;
    }
    lines.push(line);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Parses a plan markdown file content back into a PlanFile object.
 * @param {string} content - Markdown file content
 * @returns {object} PlanFile object
 */
function parsePlan(content) {
  const lines = content.split('\n');

  // Parse title from first line: # Plan: {title}
  const titleMatch = lines[0]?.match(/^# Plan: (.+)$/);
  const title = titleMatch ? titleMatch[1] : '';

  // Parse metadata comment: <!-- planId: ... | sessionId: ... | created: ... -->
  const metaMatch = lines[1]?.match(
    /<!-- planId: (.+?) \| sessionId: (.+?) \| created: (.+?) -->/
  );
  const planId = metaMatch ? metaMatch[1] : '';
  const sessionId = metaMatch ? metaMatch[2] : '';
  const createdAt = metaMatch ? metaMatch[3] : '';

  // Parse tasks
  const tasks = [];
  for (const line of lines) {
    const taskMatch = line.match(
      /^- \[([ x])\] \*\*(.+?)\*\* \| (.+?) \| status: (pending|in_progress|complete|failed)(?:\s*\|\s*critical: true)?(?:\s*\|\s*result: (.*))?$/
    );
    if (taskMatch) {
      const task = {
        id: taskMatch[2],
        description: taskMatch[3],
        critical: line.includes('| critical: true'),
        status: taskMatch[4],
      };
      if (taskMatch[5] !== undefined) {
        task.result = taskMatch[5];
      }
      tasks.push(task);
    }
  }

  return { planId, sessionId, title, createdAt, tasks };
}

/**
 * Creates a new plan and writes it to disk.
 * @param {string} sessionId - Session identifier
 * @param {string} title - Plan title
 * @param {Array<{id: string, description: string, critical?: boolean}>} tasks - Task definitions
 * @returns {object} PlanFile object
 */
export function createPlan(sessionId, title, tasks) {
  if (!title || typeof title !== 'string') {
    throw new Error('Plan title is required and must be a non-empty string');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required and must be a non-empty string');
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('Tasks must be a non-empty array');
  }
  if (tasks.length > MAX_TASKS) {
    throw new Error(`Plan cannot exceed ${MAX_TASKS} tasks (received ${tasks.length})`);
  }

  ensurePlansDir();

  const timestamp = Date.now();
  const planId = `${sessionId}_${timestamp}`;
  const createdAt = new Date(timestamp).toISOString();

  const plan = {
    planId,
    sessionId,
    title,
    createdAt,
    tasks: tasks.map((t) => ({
      id: t.id,
      description: t.description,
      critical: Boolean(t.critical),
      status: 'pending',
    })),
  };

  const filePath = join(PLANS_DIR, `${planId}.md`);
  writeFileSync(filePath, serializePlan(plan), 'utf-8');

  return plan;
}

/**
 * Updates a single task's status and optional result in an existing plan.
 * @param {string} planId - Plan identifier
 * @param {string} taskId - Task identifier within the plan
 * @param {string} status - New status: "in_progress", "complete", or "failed"
 * @param {string} [result] - Optional result text
 * @returns {object} Updated PlanFile object
 */
export function updatePlanTask(planId, taskId, status, result) {
  const validStatuses = ['pending', 'in_progress', 'complete', 'failed'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
  }

  const filePath = join(PLANS_DIR, `${planId}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const plan = parsePlan(content);

  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId} in plan ${planId}`);
  }

  task.status = status;
  if (result !== undefined) {
    task.result = result;
  }

  writeFileSync(filePath, serializePlan(plan), 'utf-8');

  return plan;
}

/**
 * Reads a plan from disk and returns the parsed PlanFile object.
 * @param {string} planId - Plan identifier
 * @returns {object} PlanFile object
 */
export function readPlan(planId) {
  const filePath = join(PLANS_DIR, `${planId}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  return parsePlan(content);
}

/**
 * Lists all plans for a given session, returning summary info.
 * @param {string} sessionId - Session identifier
 * @returns {Array<{planId: string, title: string, createdAt: string, taskCount: number, completedCount: number}>}
 */
export function listSessionPlans(sessionId) {
  ensurePlansDir();

  const files = readdirSync(PLANS_DIR).filter(
    (f) => f.startsWith(`${sessionId}_`) && f.endsWith('.md')
  );

  const summaries = [];
  for (const file of files) {
    const content = readFileSync(join(PLANS_DIR, file), 'utf-8');
    const plan = parsePlan(content);
    summaries.push({
      planId: plan.planId,
      title: plan.title,
      createdAt: plan.createdAt,
      taskCount: plan.tasks.length,
      completedCount: plan.tasks.filter((t) => t.status === 'complete').length,
    });
  }

  return summaries;
}

export default { createPlan, updatePlanTask, readPlan, listSessionPlans };
