/**
 * Brain State Manager - Gerenciador de estado distribuído
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const LockManager = require('./locks');
const Logger = require('./logger');

class StateManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || '.claude-brain/state';
    this.lockManager = new LockManager(this.baseDir);
    this.logger = new Logger({ component: 'state-manager' });

    // Global state cache
    this.state = new Map();
    this.dirtyKeys = new Set();
    this.saveTimer = null;
    this.saveInterval = options.saveInterval || 5000; // 5s

    // Changes buffer for pub/sub
    this.changeSubscribers = new Map();

    this._startAutoSave();
  }

  _startAutoSave() {
    this.saveIntervalTimer = setInterval(() => {
      this._saveDirtyKeys().catch(err => {
        this.logger.error('Auto-save failed:', err);
      });
    }, this.saveInterval);
  }

  async _saveDirtyKeys() {
    if (this.dirtyKeys.size === 0) return;

    const keysToSave = Array.from(this.dirtyKeys);
    this.dirtyKeys.clear();

    for (const key of keysToSave) {
      const value = this.state.get(key);
      await this._saveKey(key, value);
    }

    this.logger.debug('Auto-saved %d keys', keysToSave.length);
  }

  async _saveKey(key, value) {
    await this.lockManager.withLock(`state-${key}`, async () => {
      const filePath = path.join(this.baseDir, `${key}.json`);

      // Create directory if it doesn't exist
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
    });
  }

  async _loadKey(key) {
    const filePath = path.join(this.baseDir, `${key}.json`);

    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  async get(key, defaultValue = null) {
    if (this.state.has(key)) {
      return this.state.get(key);
    }

    const value = await this._loadKey(key);
    if (value !== undefined) {
      this.state.set(key, value);
      return value;
    }

    return defaultValue;
  }

  async set(key, value) {
    const oldValue = this.state.get(key);
    this.state.set(key, value);
    this.dirtyKeys.add(key);

    // Notify subscribers
    this._notifySubscribers(key, { oldValue, newValue: value });

    this.logger.debug('State set: %s = %j', key, value);
    return value;
  }

  async delete(key) {
    await this.lockManager.withLock(`state-${key}`, async () => {
      this.state.delete(key);

      const filePath = path.join(this.baseDir, `${key}.json`);
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      this.dirtyKeys.delete(key);
      this.logger.debug('State deleted: %s', key);
    });
  }

  async has(key) {
    if (this.state.has(key)) return true;
    const value = await this._loadKey(key);
    return value !== undefined;
  }

  // Pub/Sub for state changes
  subscribe(key, callback) {
    if (!this.changeSubscribers.has(key)) {
      this.changeSubscribers.set(key, new Set());
    }
    const id = crypto.randomUUID();
    this.changeSubscribers.get(key).add({ id, callback });
    return id;
  }

  unsubscribe(key, subscriptionId) {
    const subscribers = this.changeSubscribers.get(key);
    if (!subscribers) return;

    for (const sub of subscribers) {
      if (sub.id === subscriptionId) {
        subscribers.delete(sub);
        break;
      }
    }
  }

  _notifySubscribers(key, change) {
    const subscribers = this.changeSubscribers.get(key);
    if (!subscribers) return;

    for (const sub of subscribers) {
      try {
        sub.callback(change);
      } catch (err) {
        this.logger.error('Error in state subscriber:', err);
      }
    }
  }

  // Batch operations
  async getAll(keys) {
    const results = {};
    for (const key of keys) {
      results[key] = await this.get(key);
    }
    return results;
  }

  async setAll(keyValuePairs) {
    const results = {};
    for (const [key, value] of Object.entries(keyValuePairs)) {
      results[key] = await this.set(key, value);
    }
    return results;
  }

  // Search/filter
  async list(prefix = '') {
    try {
      const files = await fs.readdir(this.baseDir);
      const keys = files
        .filter(f => f.endsWith('.json') && f.replace('.json', '').startsWith(prefix))
        .map(f => f.replace('.json', ''));

      // Include keys that are in memory but not yet saved
      for (const key of this.state.keys()) {
        if (key.startsWith(prefix) && !keys.includes(key)) {
          keys.push(key);
        }
      }

      return keys.sort();
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  // Persistence
  async flush() {
    await this._saveDirtyKeys();
  }

  async loadAll() {
    try {
      const files = await fs.readdir(this.baseDir);
      const keys = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

      for (const key of keys) {
        const value = await this._loadKey(key);
        if (value !== undefined) {
          this.state.set(key, value);
        }
      }

      this.logger.debug('Loaded %d state keys', this.state.size);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  cleanup() {
    if (this.saveIntervalTimer) {
      clearInterval(this.saveIntervalTimer);
    }
    this.lockManager.cleanup();
  }

  // Global state shortcuts
  async getCurrentSession() {
    return await this.get('system.current-session');
  }

  async setCurrentSession(sessionId) {
    return await this.set('system.current-session', sessionId);
  }

  async getSessionInfo(sessionId) {
    return await this.get(`session.${sessionId}.info`);
  }

  async setSessionInfo(sessionId, info) {
    return await this.set(`session.${sessionId}.info`, info);
  }
}

module.exports = StateManager;
