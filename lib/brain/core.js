/**
 * Brain Core - Módulo central do Brain System
 */

const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const StateManager = require('./state-manager');
const Protocol = require('./protocol');
const Logger = require('./logger');

class BrainCore extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = {
      brainDir: options.brainDir || '.claude-brain',
      heartbeatInterval: options.heartbeatInterval || 5000, // 5s
      heartbeatTimeout: options.heartbeatTimeout || 15000, // 15s
      sessionTimeout: options.sessionTimeout || 300000, // 5min
      ...options
    };

    this.stateManager = new StateManager({
      baseDir: path.join(this.config.brainDir, 'state'),
      saveInterval: options.stateSaveInterval || 5000
    });

    this.protocol = new Protocol({
      channelsDir: path.join(this.config.brainDir, 'channels'),
      terminalId: 'brain'
    });

    this.logger = new Logger({ component: 'brain' });

    // Terminal registry
    this.terminals = new Map();

    // Session management
    this.activeSessions = new Map();

    // Heartbeat monitoring
    this.heartbeatTimer = null;
    this.sessionCleanupTimer = null;

    // Status
    this.startTime = null;
    this.isRunning = false;

    // Setup protocol listeners
    this._setupProtocolListeners();
  }

  _setupProtocolListeners() {
    this.protocol.on('message', (message) => {
      this._handleMessage(message).catch(err => {
        this.logger.error('Error handling message:', err);
      });
    });

    this.protocol.on('error', (err) => {
      this.logger.error('Protocol error:', err);
    });
  }

  async _handleMessage(message) {
    const { type, from, payload } = message;

    this.logger.debug('Received message %s from %s', type, from);

    switch (type) {
      case 'terminal.register':
        await this._registerTerminal(from, payload);
        break;

      case 'terminal.heartbeat':
        await this._updateTerminalHeartbeat(from, payload);
        break;

      case 'terminal.unregister':
        await this._unregisterTerminal(from);
        break;

      case 'task.create':
        await this._handleTaskCreate(payload);
        break;

      case 'task.update':
        await this._handleTaskUpdate(payload);
        break;

      case 'task.request':
        await this._handleTaskRequest(payload);
        break;

      case 'state.sync':
        await this._handleStateSync(from, payload);
        break;

      case 'broadcast.message':
        // Just log broadcasts
        this.logger.info('Broadcast from %s: %s', from, payload.message);
        break;

      default:
        this.logger.warn('Unknown message type: %s', type);
    }

    // Emit event for external handlers
    this.emit('message', message);
  }

  async _registerTerminal(terminalId, registration) {
    this.logger.info('Registering terminal %s', terminalId);

    const terminal = {
      id: terminalId,
      ...registration,
      status: 'online',
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      sessionId: null
    };

    this.terminals.set(terminalId, terminal);

    // Save to state
    await this.stateManager.set(`terminal.${terminalId}`, terminal);

    // Notify all terminals
    await this.protocol.broadcast('terminal.registered', {
      terminalId,
      terminal
    });

    this.emit('terminal:registered', terminal);
  }

  async _updateTerminalHeartbeat(terminalId, payload) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      this.logger.warn('Heartbeat from unknown terminal %s', terminalId);
      return;
    }

    terminal.lastHeartbeat = Date.now();
    terminal.status = 'online';

    if (payload.stats) {
      terminal.stats = payload.stats;
    }

    // Update state
    await this.stateManager.set(`terminal.${terminalId}`, terminal);

    this.emit('terminal:heartbeat', terminalId, payload);
  }

  async _unregisterTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    this.logger.info('Unregistering terminal %s', terminalId);

    terminal.status = 'offline';
    terminal.unregisteredAt = Date.now();

    // Update state
    await this.stateManager.set(`terminal.${terminalId}`, terminal);

    this.terminals.delete(terminalId);

    // Notify all terminals
    await this.protocol.broadcast('terminal.unregistered', {
      terminalId
    });

    this.emit('terminal:unregistered', terminalId);
  }

  async _handleTaskCreate(taskData) {
    this.logger.debug('Task created: %s', taskData.subject);

    // Store task
    const taskId = taskData.id || crypto.randomUUID();
    const task = {
      id: taskId,
      ...taskData,
      createdAt: Date.now(),
      creator: taskData.creator || 'unknown'
    };

    await this.stateManager.set(`task.${taskId}`, task);

    // Broadcast to all terminals
    await this.protocol.broadcast('task.created', task);

    this.emit('task:created', task);
  }

  async _handleTaskUpdate(update) {
    const { taskId, status, owner, ...otherFields } = update;

    const task = await this.stateManager.get(`task.${taskId}`);
    if (!task) {
      this.logger.warn('Update for unknown task %s', taskId);
      return;
    }

    // Update fields
    Object.assign(task, otherFields);
    if (status) task.status = status;
    if (owner) task.owner = owner;
    task.updatedAt = Date.now();

    await this.stateManager.set(`task.${taskId}`, task);

    // Broadcast update
    await this.protocol.broadcast('task.updated', task);

    this.emit('task:updated', task);
  }

  async _handleTaskRequest(request) {
    // Query tasks matching criteria
    const keys = await this.stateManager.list('task.');
    const tasks = [];

    for (const key of keys) {
      const task = await this.stateManager.get(key);
      if (!task) continue;

      // Filter by criteria
      let matches = true;
      if (request.status && task.status !== request.status) matches = false;
      if (request.area && task.metadata?.area !== request.area) matches = false;
      if (request.owner && task.owner !== request.owner) matches = false;

      if (matches) {
        tasks.push(task);
      }
    }

    // Sort by priority and updatedAt
    tasks.sort((a, b) => {
      if (a.priority !== b.priority) {
        return (b.priority || 3) - (a.priority || 3);
      }
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    });

    // Send response back to requester
    const response = {
      requestId: request.requestId,
      tasks: tasks.slice(0, request.limit || 100)
    };

    await this.protocol.send(request.from, 'task.response', response);
  }

  async _handleStateSync(from, keys) {
    const state = {};
    for (const key of keys) {
      state[key] = await this.stateManager.get(key);
    }

    await this.protocol.send(from, 'state.synced', state);
  }

  // Heartbeat monitoring
  _startHeartbeatMonitor() {
    this.heartbeatTimer = setInterval(() => {
      this._checkHeartbeats().catch(err => {
        this.logger.error('Heartbeat check error:', err);
      });
    }, this.config.heartbeatInterval);
  }

  async _checkHeartbeats() {
    const now = Date.now();

    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.status === 'online' &&
          now - terminal.lastHeartbeat > this.config.heartbeatTimeout) {

        this.logger.warn('Terminal %s missed heartbeat', terminalId);
        terminal.status = 'offline';

        await this.stateManager.set(`terminal.${terminalId}`, terminal);

        await this.protocol.broadcast('terminal.offline', {
          terminalId,
          since: terminal.lastHeartbeat
        });

        this.emit('terminal:offline', terminalId);
      }
    }
  }

  // Session cleanup
  _startSessionCleanup() {
    this.sessionCleanupTimer = setInterval(() => {
      this._cleanupStaleSessions().catch(err => {
        this.logger.error('Session cleanup error:', err);
      });
    }, this.config.sessionTimeout);
  }

  async _cleanupStaleSessions() {
    const now = Date.now();

    for (const [sessionId, session] of this.activeSessions) {
      if (now - session.lastActivity > this.config.sessionTimeout) {
        this.logger.info('Cleaning up stale session %s', sessionId);
        this.activeSessions.delete(sessionId);
        this.emit('session:expired', sessionId);
      }
    }
  }

  // Load all state                                                                                                                                                                                                                                                                     
  async loadAll() {
    // Load existing state                                                                                                                                                                                                                                                              
    await this.stateManager.loadAll();                 
    this.logger.debug('Loaded %d state keys', this.stateManager.state.size);                                                                                                                                                                                                            
                                                       
    // Load terminals                                                                                                                                                                                                                                                                   
    const terminals = await this.getTerminals();
    this.logger.debug('Loaded %d terminals', Object.keys(terminals).length);                                                                                                                                                                                                            
  }

  // Control
  async start() {
    if (this.isRunning) return;

    this.logger.info('Starting Brain Core...');
    this.startTime = Date.now();

    // Load existing state
    await this.stateManager.loadAll();
    this.logger.debug('Loaded %d state keys', this.stateManager.state.size);

    // Start protocol
    await this.protocol.start();

    // Start monitors
    this._startHeartbeatMonitor();
    this._startSessionCleanup();

    // Save startup info
    await this.stateManager.set('system.startTime', this.startTime);

    this.isRunning = true;
    this.logger.info('Brain Core started successfully');

    this.emit('start');
  }

  async stop() {
    if (!this.isRunning) return;

    this.logger.info('Stopping Brain Core...');

    // Stop monitors
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }

    // Stop protocol
    await this.protocol.stop();

    // Flush state
    await this.stateManager.flush();

    this.isRunning = false;
    this.logger.info('Brain Core stopped');

    this.emit('stop');
  }

  cleanup() {
    this.removeAllListeners();
    this.protocol.cleanup();
    this.stateManager.cleanup();
  }

  // Info
  getInfo() {
    return {
      isRunning: this.isRunning,
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      terminals: this.terminals.size,
      sessions: this.activeSessions.size,
      stateKeys: this.stateManager.state.size
    };
  }

  async getTerminals() {
    const keys = await this.stateManager.list('terminal.');
    const terminals = {};

    for (const key of keys) {
      const terminalId = key.replace('terminal.', '');
      terminals[terminalId] = await this.stateManager.get(key);
    }

    return terminals;
  }
}

module.exports = BrainCore;
