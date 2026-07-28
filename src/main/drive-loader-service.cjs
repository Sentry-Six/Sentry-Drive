'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDriveIndex, indexDriveData } = require('./drive-index.cjs');
const { groupIndexedDrives } = require('./disk-drive-grouper.cjs');

function containsPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function removeLoadDirectory(cacheRoot, loadDir) {
  if (!loadDir || !containsPath(cacheRoot, loadDir)) return;
  fs.rmSync(loadDir, { recursive: true, force: true });
}

function structuredError(error) {
  if (error?.name === 'AbortError') return error;
  const wrapped = new Error(error?.message ?? String(error));
  wrapped.code = error?.code === 'SQLITE_FULL'
    ? 'DRIVE_DATA_CACHE_FULL'
    : 'DRIVE_DATA_INVALID';
  wrapped.cause = error;
  return wrapped;
}

class LoaderService {
  constructor({ cacheRoot, send = () => {} }) {
    if (!cacheRoot) throw new TypeError('cacheRoot is required');
    this.cacheRoot = path.resolve(cacheRoot);
    this.send = send;
    this.index = null;
    this.loadDir = null;
    this.abortController = null;
    fs.mkdirSync(this.cacheRoot, { recursive: true });
  }

  async load({ filePath, pageSize = 250 }) {
    await this.closeCurrent();
    const before = fs.statSync(filePath);
    this.loadDir = path.join(this.cacheRoot, randomUUID());
    fs.mkdirSync(this.loadDir, { recursive: true });
    this.index = createDriveIndex({
      dbPath: path.join(this.loadDir, 'drive-index.sqlite'),
      sourcePath: filePath,
    });
    this.abortController = new AbortController();

    try {
      const counts = await indexDriveData(this.index, {
        signal: this.abortController.signal,
        onProgress: (current, total) => {
          this.send({ type: 'progress', payload: { phase: 'reading', current, total } });
        },
      });
      const afterIndex = fs.statSync(filePath);
      if (afterIndex.size !== before.size || afterIndex.mtimeMs !== before.mtimeMs) {
        const error = new Error('The drive data file changed while it was loading. Please retry.');
        error.code = 'DRIVE_DATA_CHANGED';
        throw error;
      }
      const grouped = await groupIndexedDrives(this.index, {
        signal: this.abortController.signal,
        onProgress: (payload) => this.send({ type: 'progress', payload }),
      });
      const page = this.index.listDriveSummaries({ offset: 0, limit: pageSize });
      this.send({ type: 'progress', payload: { phase: 'preparing', current: 1, total: 1 } });
      return {
        success: true,
        ...counts,
        ...grouped,
        drives: page.drives,
        page: {
          offset: page.offset,
          limit: page.limit,
          total: page.total,
        },
      };
    } catch (error) {
      await this.closeCurrent();
      if (error?.code === 'DRIVE_DATA_CHANGED' || error?.name === 'AbortError') throw error;
      throw structuredError(error);
    }
  }

  async handle({ type, payload = {} }) {
    switch (type) {
      case 'load':
        return this.load(payload);
      case 'list':
        if (!this.index) throw Object.assign(new Error('No drive data is loaded'), { code: 'NO_DRIVE_DATA' });
        return this.index.listDriveSummaries(payload);
      case 'detail':
        if (!this.index) throw Object.assign(new Error('No drive data is loaded'), { code: 'NO_DRIVE_DATA' });
        return this.index.getDriveDetail(payload.id, payload.maxPoints);
      case 'cancel':
        this.abortController?.abort();
        return { canceled: true };
      case 'close':
        await this.close();
        return { closed: true };
      default:
        throw Object.assign(new Error(`Unknown loader request: ${type}`), { code: 'BAD_LOADER_REQUEST' });
    }
  }

  async closeCurrent() {
    this.abortController?.abort();
    this.abortController = null;
    this.index?.close();
    this.index = null;
    const loadDir = this.loadDir;
    this.loadDir = null;
    removeLoadDirectory(this.cacheRoot, loadDir);
  }

  async close() {
    await this.closeCurrent();
    fs.mkdirSync(this.cacheRoot, { recursive: true });
  }
}

function createLoaderService(options) {
  return new LoaderService(options);
}

module.exports = {
  containsPath,
  createLoaderService,
  removeLoadDirectory,
};
