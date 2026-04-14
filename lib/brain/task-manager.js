/**
 * Brain Task Manager - Gerenciador de tarefas distribuídas
 */

const crypto = require('crypto');
const path = require('path');
const StateManager = require('./state-manager');
const Protocol = require('./protocol');
const Logger = require('./logger');

class TaskManager {
  constructor(options = {}) {
    this.stateManager = options.stateManager || new StateManager();
    this.protocol = options.protocol || new Protocol();
    this.logger = new Logger({ component: 'task-manager' });
  }

  // Task structure validation
  _validateTask(task) {
    const errors = [];

    if (!task.subject || typeof task.subject !== 'string') {
      errors.push('Task subject is required and must be a string');
    }

    if (task.priority !== undefined && (task.priority < 1 || task.priority > 5)) {
      errors.push('Task priority must be between 1 and 5');
    }

    if (task.status !== undefined && !['pending', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(task.status)) {
      errors.push('Task status must be one of: pending, in_progress, completed, blocked, cancelled');
    }

    if (task.owner && typeof task.owner !== 'string') {
      errors.push('Task owner must be a string');
    }

    if (task.metadata !== undefined && typeof task.metadata !== 'object') {
      errors.push('Task metadata must be an object');
    }

    return errors;
  }

  // Generate task from data
  _buildTask(data, options = {}) {
    const now = Date.now();

    return {
      id: data.id || crypto.randomUUID(),
      subject: data.subject,
      description: data.description || '',
      status: data.status || 'pending',
      priority: data.priority || 3,
      owner: data.owner || null,
      creator: data.creator || options.creator || 'unknown',
      blockedBy: data.blockedBy || [],
      blocks: data.blocks || [],
      metadata: data.metadata || {},
      tags: data.tags || [],
      createdAt: data.createdAt || now,
      updatedAt: data.updatedAt || now,
      completedAt: data.completedAt || null,
      assignedAt: data.assignedAt || null,
      ...options.overrides || {}
    };
  }

  // Create a new task
  async create(taskData, options = {}) {
    const errors = this._validateTask(taskData);
    if (errors.length > 0) {
      throw new Error(`Invalid task: ${errors.join(', ')}`);
    }

    const task = this._buildTask(taskData, options);

    // Save to state
    await this.stateManager.set(`task.${task.id}`, task);

    this.logger.info('Created task %s: %s', task.id, task.subject);

    // Broadcast task creation
    if (options.broadcast !== false) {
      await this.protocol.broadcast('task.created', task);
    }

    return task;
  }

  // Update an existing task
  async update(taskId, updates, options = {}) {
    const task = await this.stateManager.get(`task.${taskId}`);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Validate updates
    const errors = this._validateTask({ ...task, ...updates });
    if (errors.length > 0) {
      throw new Error(`Invalid task update: ${errors.join(', ')}`);
    }

    // Apply updates
    Object.assign(task, updates);
    task.id = taskId; // Ensure ID doesn't change
    task.updatedAt = Date.now();

    // Set special timestamps
    if (updates.status === 'completed' && !task.completedAt) {
      task.completedAt = Date.now();
    }

    if (updates.owner && updates.owner !== task.owner) {
      task.assignedAt = Date.now();
    }

    // Save updated task
    await this.stateManager.set(`task.${taskId}`, task);

    this.logger.info('Updated task %s: status=%s', taskId, task.status);

    // Broadcast task update
    if (options.broadcast !== false) {
      await this.protocol.broadcast('task.updated', task);
    }

    return task;
  }

  // Get a task by ID
  async get(taskId) {
    return await this.stateManager.get(`task.${taskId}`);
  }

  // Delete a task
  async delete(taskId, options = {}) {
    const task = await this.stateManager.get(`task.${taskId}`);
    if (!task) {
      return false;
    }

    await this.stateManager.delete(`task.${taskId}`);

    this.logger.info('Deleted task %s', taskId);

    // Broadcast task deletion
    if (options.broadcast !== false) {
      await this.protocol.broadcast('task.deleted', { taskId, task });
    }

    return true;
  }

  // List tasks with filtering and sorting
  async list(options = {}) {
    const {
      status,
      area,
      owner,
      creator,
      priority,
      tags = [],
      limit = 100,
      offset = 0,
      sortBy = 'priority',
      sortOrder = 'desc'
    } = options;

    // Get all task keys
    const keys = await this.stateManager.list('task.');

    // Load and filter tasks
    const tasks = [];
    for (const key of keys) {
      const task = await this.stateManager.get(key);
      if (!task) continue;

      let matches = true;

      if (status !== undefined && task.status !== status) matches = false;
      if (area !== undefined && task.metadata?.area !== area) matches = false;
      if (owner !== undefined && task.owner !== owner) matches = false;
      if (creator !== undefined && task.creator !== creator) matches = false;
      if (priority !== undefined && task.priority !== priority) matches = false;

      if (tags.length > 0) {
        const taskTags = new Set(task.tags || []);
        const hasAllTags = tags.every(tag => taskTags.has(tag));
        if (!hasAllTags) matches = false;
      }

      if (matches) {
        tasks.push(task);
      }
    }

    // Sort tasks
    tasks.sort((a, b) => {
      const aValue = a[sortBy] || 0;
      const bValue = b[sortBy] || 0;

      let comparison = 0;
      if (aValue < bValue) comparison = -1;
      if (aValue > bValue) comparison = 1;

      return sortOrder === 'desc' ? -comparison : comparison;
    });

    // Apply pagination
    const paginatedTasks = tasks.slice(offset, offset + limit);

    return {
      tasks: paginatedTasks,
      total: tasks.length,
      offset,
      limit
    };
  }

  // Assign a task to a terminal
  async assign(taskId, terminalId, options = {}) {
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Update task
    await this.update(taskId, {
      owner: terminalId,
      status: options.status || 'in_progress',
      assignedAt: Date.now()
    }, options);

    const terminal = await this.stateManager.get(`terminal.${terminalId}`);
    const terminalName = terminal?.name || terminalId;

    this.logger.info('Assigned task %s to terminal %s', taskId, terminalName);

    // Notify terminal
    await this.protocol.send(terminalId, 'task.assigned', {
      taskId,
      task: await this.get(taskId)
    });

    return { taskId, terminalId };
  }

  // Unassign a task
  async unassign(taskId, options = {}) {
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const previousOwner = task.owner;

    await this.update(taskId, {
      owner: null,
      status: options.status || 'pending'
    }, options);

    this.logger.info('Unassigned task %s', taskId);

    // Notify previous owner
    if (previousOwner) {
      await this.protocol.send(previousOwner, 'task.unassigned', {
        taskId,
        task: await this.get(taskId)
      });
    }

    return { taskId, previousOwner };
  }

  // Query tasks
  async query(criteria, options = {}) {
    return await this.list({ ...criteria, ...options });
  }

  // Get task statistics
  async getStats(options = {}) {
    const { area, owner, creator } = options;

    const keys = await this.stateManager.list('task.');
    const stats = {
      total: 0,
      byStatus: {},
      byArea: {},
      byOwner: {},
      byPriority: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    };

    for (const key of keys) {
      const task = await this.stateManager.get(key);
      if (!task) continue;

      // Apply filters
      if (area !== undefined && task.metadata?.area !== area) continue;
      if (owner !== undefined && task.owner !== owner) continue;
      if (creator !== undefined && task.creator !== creator) continue;

      // Update counts
      stats.total++;

      const status = task.status || 'pending';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

      const taskArea = task.metadata?.area || 'unknown';
      stats.byArea[taskArea] = (stats.byArea[taskArea] || 0) + 1;

      const taskOwner = task.owner || 'unassigned';
      stats.byOwner[taskOwner] = (stats.byOwner[taskOwner] || 0) + 1;

      const priority = task.priority || 3;
      stats.byPriority[priority] = (stats.byPriority[priority] || 0) + 1;
    }

    return stats;
  }

  // Find blocked tasks
  async findBlockedTasks(options = {}) {
    const keys = await this.stateManager.list('task.');
    const blockedTasks = [];

    for (const key of keys) {
      const task = await this.stateManager.get(key);
      if (!task) continue;

      if (task.status !== 'blocked') continue;
      if (options.area && task.metadata?.area !== options.area) continue;
      if (options.owner && task.owner !== options.owner) continue;

      // Check if blocking tasks are completed
      const blockingTasks = [];
      for (const blockerId of task.blockedBy) {
        const blocker = await this.get(blockerId);
        if (blocker && blocker.status !== 'completed') {
          blockingTasks.push(blocker);
        }
      }

      if (blockingTasks.length > 0 || task.blockedBy.length === 0) {
        // Truly blocked
        blockedTasks.push({
          task,
          blocking: blockingTasks
        });
      }
    }

    return blockedTasks;
  }

  // Validate task dependencies
  async validateDependencies(taskId) {
    const task = await this.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const issues = [];

    // Check blockedBy
    for (const blockerId of task.blockedBy) {
      const blocker = await this.get(blockerId);
      if (!blocker) {
        issues.push({
          type: 'missing-blocker',
          blockerId
        });
      }
    }

    // Check blocks (circular dependency)
    const visited = new Set();
    const visiting = new Set();

    const checkCycle = async (currentId, path = []) => {
      if (visiting.has(currentId)) {
        issues.push({
          type: 'circular-dependency',
          cycle: [...path, currentId]
        });
        return;
      }

      if (visited.has(currentId)) return;

      visiting.add(currentId);
      path.push(currentId);

      const current = await this.get(currentId);
      if (current && current.blocks) {
        for (const nextId of current.blocks) {
          await checkCycle(nextId, [...path]);
        }
      }

      visiting.delete(currentId);
      visited.add(currentId);
    };

    await checkCycle(taskId, []);

    return {
      valid: issues.length === 0,
      issues
    };
  }

  // Cleanup tasks
  async cleanup(options = {}) {
    const { olderThan, status = 'completed' } = options;
    const cutoff = olderThan || (Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

    const keys = await this.stateManager.list('task.');
    const cleaned = [];

    for (const key of keys) {
      const task = await this.stateManager.get(key);
      if (!task) continue;

      const isStale = task.updatedAt < cutoff || task.completedAt < cutoff;
      const matchesStatus = task.status === status;

      if (isStale && matchesStatus) {
        await this.stateManager.delete(key);
        cleaned.push(task);
        this.logger.debug('Cleaned up stale task %s', task.id);
      }
    }

    this.logger.info('Cleaned up %d stale tasks', cleaned.length);
    return cleaned;
  }
}

module.exports = TaskManager;
