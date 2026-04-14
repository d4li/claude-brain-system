/**
 * Brain Logger - Sistema de logging distribuído
 */

const fs = require('fs').promises;
const path = require('path');
const { format } = require('util');

class Logger {
  constructor(options = {}) {
    this.component = options.component || 'brain';
    this.logDir = options.logDir || '.claude-brain/logs';
    this.level = options.level || 'info'; // debug, info, warn, error
    this.consoleOutput = options.consoleOutput !== false;
    this._buffer = [];
    this._flushTimer = null;
    this._flushInterval = options.flushInterval || 1000; // 1s
  }

  _formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const formatted = args.length > 0 ? format(message, ...args) : message;
    return {
      timestamp,
      level,
      component: this.component,
      message: formatted
    };
  }

  _shouldLog(level) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    return levels[level] <= levels[this.level];
  }

  _enqueue(entry) {
    this._buffer.push(entry);

    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flush(), this._flushInterval);
    }
  }

  async _flush() {
    if (this._buffer.length === 0) {
      this._flushTimer = null;
      return;
    }

    const entries = [...this._buffer];
    this._buffer = [];
    this._flushTimer = null;

    try {
      // Write to component log
      const logFile = path.join(this.logDir, `${this.component}.log`);
      const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(logFile, lines);

      // Write to brain.log for all components except brain
      if (this.component !== 'brain') {
        const brainLogFile = path.join(this.logDir, 'brain.log');
        await fs.appendFile(brainLogFile, lines);
      }
    } catch (err) {
      // Can't log the error, would cause infinite loop
      console.error('Logger flush error:', err);
    }
  }

  _outputToConsole(entry) {
    if (!this.consoleOutput) return;

    const { timestamp, level, component, message } = entry;
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;

    switch (level) {
      case 'error':
        console.error(prefix, message);
        break;
      case 'warn':
        console.warn(prefix, message);
        break;
      case 'debug':
        console.debug(prefix, message);
        break;
      default:
        console.log(prefix, message);
    }
  }

  debug(message, ...args) {
    if (!this._shouldLog('debug')) return;
    const entry = this._formatMessage('debug', message, ...args);
    this._outputToConsole(entry);
    this._enqueue(entry);
  }

  info(message, ...args) {
    if (!this._shouldLog('info')) return;
    const entry = this._formatMessage('info', message, ...args);
    this._outputToConsole(entry);
    this._enqueue(entry);
  }

  warn(message, ...args) {
    if (!this._shouldLog('warn')) return;
    const entry = this._formatMessage('warn', message, ...args);
    this._outputToConsole(entry);
    this._enqueue(entry);
  }

  error(message, ...args) {
    if (!this._shouldLog('error')) return;
    const entry = this._formatMessage('error', message, ...args);
    this._outputToConsole(entry);
    this._enqueue(entry);
  }

  async flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      await this._flush();
    }
  }

  child(options = {}) {
    return new Logger({
      component: options.component || this.component,
      logDir: this.logDir,
      level: options.level || this.level,
      consoleOutput: options.consoleOutput !== undefined ? options.consoleOutput : this.consoleOutput
    });
  }
}

// Global logger instance
const globalLogger = new Logger({ component: 'brain' });

module.exports = Logger;
module.exports.globalLogger = globalLogger;
