'use strict';

class DriveLoaderClient {
  constructor({ fork, workerPath, cacheRoot, logger = null }) {
    if (typeof fork !== 'function') throw new TypeError('fork is required');
    this.fork = fork;
    this.workerPath = workerPath;
    this.cacheRoot = cacheRoot;
    this.logger = logger;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.progressHandler = null;
  }

  ensureChild() {
    if (this.child) return this.child;
    const child = this.fork(this.workerPath, [this.cacheRoot], {
      serviceName: 'Sentry Drive Loader',
      stdio: 'pipe',
    });
    this.child = child;
    child.on('message', (message) => this.onMessage(message));
    child.on('exit', (code) => this.onExit(code));
    child.on('error', (error) => {
      this.logger?.error?.('loader', 'utility process fatal error:', error);
    });
    child.stderr?.on?.('data', (chunk) => {
      this.logger?.error?.('loader', String(chunk).trim());
    });
    return child;
  }

  onMessage(message) {
    if (message?.type === 'progress') {
      this.progressHandler?.(message.payload);
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = new Error(message.error?.message ?? 'Drive loader request failed');
    error.code = message.error?.code ?? 'DRIVE_LOADER_FAILED';
    error.stack = message.error?.stack ?? error.stack;
    pending.reject(error);
  }

  onExit(code) {
    const error = new Error(`Drive loader exited unexpectedly (code ${code})`);
    error.code = 'DRIVE_LOADER_EXITED';
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child = null;
    this.progressHandler = null;
  }

  request(type, payload = {}) {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ id, type, payload });
    });
  }

  load(filePath, onProgress) {
    this.progressHandler = onProgress ?? null;
    return this.request('load', { filePath }).finally(() => {
      this.progressHandler = null;
    });
  }

  list(query) {
    return this.request('list', query);
  }

  detail(id, maxPoints = 200_000) {
    return this.request('detail', { id, maxPoints });
  }

  setTags(startTime, tags) {
    return this.request('setTags', { startTime, tags });
  }

  cancel() {
    return this.request('cancel');
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const error = new Error('Drive loader closed');
    error.code = 'DRIVE_LOADER_CLOSED';
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.progressHandler = null;
    try {
      child.postMessage({ id: 0, type: 'close', payload: {} });
    } catch {
      // Process has already gone away.
    }
    child.kill();
  }
}

function createDriveLoaderClient(options) {
  return new DriveLoaderClient(options);
}

module.exports = {
  createDriveLoaderClient,
};
