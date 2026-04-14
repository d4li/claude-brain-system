/**
 * Brain System - Export main modules
 */

const BrainCore = require('./core');
const Protocol = require('./protocol');
const StateManager = require('./state-manager');
const TaskManager = require('./task-manager');
const Logger = require('./logger');
const LockManager = require('./locks');

module.exports = {
  BrainCore,
  Protocol,
  StateManager,
  TaskManager,
  Logger,
  LockManager
};

// Create default instance
const brain = new BrainCore();

module.exports.default = brain;
module.exports.brain = brain;
