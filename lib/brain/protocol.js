/**
 * Brain Protocol - Protocolo de comunicação baseado em arquivos (IPC)
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const LockManager = require('./locks');
const Logger = require('./logger');

class Protocol extends EventEmitter {
  constructor(options = {}) {
    super();

    this.channelsDir = options.channelsDir || '.claude-brain/channels';
    this.terminalId = options.terminalId || 'brain';
    this.lockManager = new LockManager(this.channelsDir);
    this.logger = new Logger({ component: `protocol-${this.terminalId}` });

    // Active listeners
    this.listeners = new Map();
    this.pollingIntervals = new Map();

    this.isRunning = false;
  }

  // Message format
  _createMessage(type, payload, options = {}) {
    return {
      id: crypto.randomUUID(),
      from: this.terminalId,
      to: options.to || 'all',
      type,
      payload,
      timestamp: Date.now(),
      priority: options.priority || 3, // 1-5, 5 = highest
      channel: options.channel || 'default'
    };
  }

  _serializeMessage(message) {
    return JSON.stringify(message);
  }

  _deserializeMessage(line) {
    try {
      return JSON.parse(line);
    } catch (err) {
      this.logger.error('Failed to parse message:', err);
      return null;
    }
  }

  // Channel management
  _getChannelPath(channel = 'default') {
    return path.join(this.channelsDir, `${channel}.msg`);
  }

  async _ensureChannelExists(channel = 'default') {
    const channelPath = this._getChannelPath(channel);
    try {
      await fs.writeFile(channelPath, '', { flag: 'a' });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;

      // Create directory first
      await fs.mkdir(path.dirname(channelPath), { recursive: true });
      await fs.writeFile(channelPath, '', { flag: 'a' });
    }
  }

  // Pub/Sub messaging
  async publish(channel, message) {
    await this._ensureChannelExists(channel);
    const channelPath = this._getChannelPath(channel);

    const line = this._serializeMessage(message) + '\n';

    await this.lockManager.withLock(`channel-${channel}`, async () => {
      await fs.appendFile(channelPath, line, 'utf8');
    });

    this.logger.debug('Published to %s: %j', channel, message.type);
    return message.id;
  }

  async subscribe(channel, callback, options = {}) {
    await this._ensureChannelExists(channel);

    const listenerId = crypto.randomUUID();
    const listener = {
      id: listenerId,
      callback,
      position: 0,
      lastReadTime: Date.now()
    };

    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Map());
    }
    this.listeners.get(channel).set(listenerId, listener);

    this.logger.debug('Subscribed to channel %s: %s', channel, listenerId);

    // Start polling if needed
    if (options.autoPoll !== false) {
      this._startPolling(channel);
    }

    return listenerId;
  }

  async unsubscribe(channel, listenerId) {
    const channelListeners = this.listeners.get(channel);
    if (!channelListeners) return false;

    const deleted = channelListeners.delete(listenerId);
    if (deleted) {
      this.logger.debug('Unsubscribed from %s: %s', channel, listenerId);
    }

    // Stop polling if no listeners
    if (channelListeners.size === 0) {
      this._stopPolling(channel);
    }

    return deleted;
  }

  // Polling
  _startPolling(channel) {
    if (this.pollingIntervals.has(channel)) return;

    const interval = setInterval(() => {
      this._pollChannel(channel).catch(err => {
        this.logger.error('Polling error:', err);
      });
    }, 250); // 250ms polling (4 times per second)

    this.pollingIntervals.set(channel, interval);
    this.logger.debug('Started polling channel %s', channel);
  }

  _stopPolling(channel) {
    const interval = this.pollingIntervals.get(channel);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(channel);
      this.logger.debug('Stopped polling channel %s', channel);
    }
  }

  async _pollChannel(channel) {
    const listenerId = `poll-${channel}-${Date.now()}`;
    await this._pollOnce(channel, listenerId);
  }

  async _pollOnce(channel, listenerId) {
    const channelListeners = this.listeners.get(channel);
    if (!channelListeners || channelListeners.size === 0) return;

    await this.lockManager.withLock(`channel-${channel}-read`, async () => {
      const channelPath = this._getChannelPath(channel);
      const stats = await fs.stat(channelPath);

      // Check if file has new content
      let hasNewContent = false;
      for (const listener of channelListeners.values()) {
        if (listener.position < stats.size) {
          hasNewContent = true;
          break;
        }
      }

      if (!hasNewContent) return;

      // Read file
      const content = await fs.readFile(channelPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      // Process messages for each listener
      for (const listener of channelListeners.values()) {
        if (listener.position >= lines.length) continue;

        const newLines = lines.slice(listener.position);
        listener.position = lines.length;
        listener.lastReadTime = Date.now();

        for (const line of newLines) {
          const message = this._deserializeMessage(line);
          if (!message) continue;

          // Skip own messages
          if (message.from === this.terminalId) continue;

          // Check if message is for this terminal or broadcast
          if (message.to !== 'all' && message.to !== this.terminalId) {
            continue;
          }

          try {
            await listener.callback(message);
            this.emit('message', message);
          } catch (err) {
            this.logger.error('Error in subscription callback:', err);
          }
        }
      }

      // Clean up very old messages (keep last 1000)
      if (lines.length > 1000) {
        const keepFrom = lines.length - 1000;
        const keepContent = lines.slice(keepFrom).join('\n') + '\n';
        await fs.writeFile(channelPath, keepContent, 'utf8');

        // Update positions
        for (const listener of channelListeners.values()) {
          if (listener.position > keepFrom) {
            listener.position = listener.position - keepFrom;
          } else {
            listener.position = 0;
          }
        }
      }
    });
  }

  // High-level messaging
  async send(to, type, payload, options = {}) {
    const message = this._createMessage(type, payload, { ...options, to });
    return await this.publish(message.channel || 'default', message);
  }

  async broadcast(type, payload, options = {}) {
    const message = this._createMessage(type, payload, options);
    message.to = 'all';
    return await this.publish(message.channel || 'broadcast', message);
  }

  async request(to, type, payload, options = {}) {
    const messageId = crypto.randomUUID();
    const message = this._createMessage(type, payload, {
      ...options,
      to,
      replyTo: this.terminalId,
      id: messageId
    });

    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 30000; // 30s
      const timeoutTimer = setTimeout(() => {
        this.off(`response:${messageId}`, handleResponse);
        reject(new Error(`Request timeout for message ${messageId}`));
      }, timeout);

      const handleResponse = (response) => {
        clearTimeout(timeoutTimer);
        this.off(`response:${messageId}`, handleResponse);
        resolve(response);
      };

      this.once(`response:${messageId}`, handleResponse);

      this.publish(message.channel || 'default', message).catch(reject);
    });
  }

  async respond(toMessage, payload, options = {}) {
    const response = this._createMessage(`${toMessage.type}.response`, payload, {
      ...options,
      to: toMessage.from,
      inReplyTo: toMessage.id
    });
    response.channel = toMessage.channel || 'default';
    return await this.publish(response.channel, response);
  }

  // Control
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Start polling for all channels with listeners
    for (const channel of this.listeners.keys()) {
      this._startPolling(channel);
    }

    this.logger.info('Protocol started');
    this.emit('start');
  }

  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    // Stop all polling
    for (const channel of this.pollingIntervals.keys()) {
      this._stopPolling(channel);
    }

    // Flush any pending operations
    await this.lockManager.cleanup();

    this.logger.info('Protocol stopped');
    this.emit('stop');
  }

  cleanup() {
    this.removeAllListeners();
    this.lockManager.cleanup();
  }

  // Stats
  getStats() {
    return {
      channels: Array.from(this.listeners.keys()),
      listenersPerChannel: Array.from(this.listeners.entries()).map(([c, m]) => ({
        channel: c,
        listeners: m.size
      })),
      pollingChannels: Array.from(this.pollingIntervals.keys()),
      isRunning: this.isRunning
    };
  }
}

module.exports = Protocol;
