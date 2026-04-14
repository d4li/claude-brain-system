/**
 * Brain Lock Manager - Prevents race conditions in file-based operations
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class LockManager {
  constructor(baseDir = '.claude-brain/state') {
    this.baseDir = baseDir;
    this.locks = new Map();
    this.timeouts = new Map();
  }

  async acquireLock(resource, timeout = 5000) {
    const lockFile = path.join(this.baseDir, `${resource}.lock`);
    const lockId = crypto.randomUUID();
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Try to create lock file exclusively
        await fs.writeFile(lockFile, lockId, { flag: 'wx' });
        this.locks.set(resource, lockId);

        // Set auto-cleanup timeout
        const cleanup = setTimeout(() => {
          this.releaseLock(resource, lockId);
        }, 30000); // Auto-release after 30s

        this.timeouts.set(resource, cleanup);
        return lockId;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Lock exists, wait and retry
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Timeout acquiring lock for ${resource}`);
  }

  async releaseLock(resource, lockId) {
    const lockFile = path.join(this.baseDir, `${resource}.lock`);

    // Clear timeout
    const timeout = this.timeouts.get(resource);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(resource);
    }

    // Only release if we own the lock
    const currentLockId = this.locks.get(resource);
    if (currentLockId === lockId) {
      try {
        await fs.unlink(lockFile);
        this.locks.delete(resource);
        return true;
      } catch (err) {
        // Lock file might be already cleaned up
        this.locks.delete(resource);
        return false;
      }
    }

    return false;
  }

  async withLock(resource, operation, timeout = 5000) {
    const lockId = await this.acquireLock(resource, timeout);
    try {
      return await operation();
    } finally {
      await this.releaseLock(resource, lockId);
    }
  }

  cleanup() {
    for (const [resource, timeout] of this.timeouts) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.locks.clear();
  }
}

module.exports = LockManager;
