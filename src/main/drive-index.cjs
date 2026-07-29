'use strict';

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');
const { chain } = require('stream-chain');
const { parser } = require('stream-json/parser.js');
const AssemblerModule = require('stream-json/assembler.js');
const Assembler = AssemblerModule.Assembler ?? AssemblerModule;
const { DRIVE_GAP_MS } = require('../shared/drive-calc.cjs');
const { parseClipTimestampMs } = require('../shared/event-gap-fill.cjs');
const { normalizeClipPath } = require('../shared/clip-path.cjs');
const parseFileTimestampMs = parseClipTimestampMs;

function abortError() {
  const err = new Error('Drive data indexing canceled');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

class DriveIndex {
  constructor({ dbPath, sourcePath }) {
    if (!dbPath || !sourcePath) throw new TypeError('dbPath and sourcePath are required');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.sourcePath = sourcePath;
    this.db = new DatabaseSync(dbPath);
    this.closed = false;
    this.db.exec(`
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-32768;
      CREATE TABLE IF NOT EXISTS routes (
        id INTEGER PRIMARY KEY,
        sequence INTEGER NOT NULL,
        normalized_file TEXT NOT NULL UNIQUE,
        timestamp_ms INTEGER NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS routes_timestamp
        ON routes(timestamp_ms, sequence);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drives (
        id INTEGER PRIMARY KEY,
        start_time TEXT NOT NULL,
        source TEXT NOT NULL,
        summary BLOB NOT NULL,
        detail BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drives_start_time
        ON drives(start_time DESC, id DESC);
    `);
    this.insertRouteStmt = this.db.prepare(`
      INSERT OR IGNORE INTO routes
        (sequence, normalized_file, timestamp_ms, payload)
      VALUES (?, ?, ?, ?)
    `);
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);
    this.getMetaStmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this.insertDriveStmt = this.db.prepare(`
      INSERT INTO drives(id, start_time, source, summary, detail)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.getDriveDetailStmt = this.db.prepare('SELECT detail FROM drives WHERE id = ?');
  }

  insertRoute(route, sequence) {
    const normalizedFile = normalizeClipPath(route?.file);
    if (!normalizedFile) return 'dropped';
    const timestampMs = parseClipTimestampMs(normalizedFile);
    if (timestampMs == null) return 'dropped';
    const result = this.insertRouteStmt.run(
      sequence,
      normalizedFile,
      timestampMs,
      v8.serialize({ ...route, file: normalizedFile }),
    );
    return result.changes === 1 ? 'inserted' : 'duplicate';
  }

  beginIndexing() {
    this.db.exec('BEGIN IMMEDIATE');
  }

  commitIndexing() {
    this.db.exec('COMMIT');
  }

  rollbackIndexing() {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // No active transaction (for example, parsing failed before BEGIN).
    }
  }

  setMeta(key, value) {
    this.setMetaStmt.run(key, v8.serialize(value));
  }

  getMetaValue(key, fallback) {
    const row = this.getMetaStmt.get(key);
    return row ? v8.deserialize(row.value) : fallback;
  }

  getMeta() {
    return this.getMetaValue('counts', {
      processedFileCount: 0,
      routeCount: 0,
      droppedCount: 0,
      duplicateCount: 0,
    });
  }

  getDriveTags() {
    return this.getMetaValue('driveTags', {});
  }

  clearDrives() {
    this.db.exec('DELETE FROM drives');
  }

  putDrive(summary, detail) {
    this.insertDriveStmt.run(
      summary.id,
      summary.startTime,
      summary.source ?? 'sei',
      v8.serialize(summary),
      v8.serialize(detail),
    );
  }

  listDriveSummaries({ offset = 0, limit = 250 } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
    const boundedOffset = Math.max(0, Number(offset) || 0);
    const total = Number(this.db.prepare('SELECT COUNT(*) AS total FROM drives').get().total);
    const rows = this.db.prepare(`
      SELECT summary
      FROM drives
      ORDER BY start_time DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(boundedLimit, boundedOffset);
    return {
      total,
      offset: boundedOffset,
      limit: boundedLimit,
      drives: rows.map((row) => v8.deserialize(row.summary)),
    };
  }

  getDriveDetail(id, maxPoints = 200_000) {
    const row = this.getDriveDetailStmt.get(id);
    if (!row) return null;
    const detail = v8.deserialize(row.detail);
    const fullPoints = detail.points ?? [];
    const fullPointCount = fullPoints.length;
    const budget = Math.max(2, Math.min(Number(maxPoints) || 200_000, 200_000));
    if (fullPointCount <= budget) {
      return { ...detail, fullPointCount, displayPointCount: fullPointCount, downsampled: false };
    }
    const indices = evenlySpacedIndices(fullPointCount, budget);
    const pick = (values) => values ? indices.map((index) => values[index]) : undefined;
    return {
      ...detail,
      points: pick(fullPoints),
      fsdStates: pick(detail.fsdStates),
      gearStates: pick(detail.gearStates),
      fullPointCount,
      displayPointCount: indices.length,
      downsampled: true,
    };
  }

  *iterateTimeWindows() {
    const rows = this.db.prepare(`
      SELECT timestamp_ms, payload
      FROM routes
      ORDER BY timestamp_ms, sequence
    `).iterate();
    let window = [];
    let previousMs = null;
    for (const row of rows) {
      if (previousMs != null && row.timestamp_ms - previousMs > DRIVE_GAP_MS) {
        yield window;
        window = [];
      }
      window.push(v8.deserialize(row.payload));
      previousMs = row.timestamp_ms;
    }
    if (window.length > 0) yield window;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function createDriveIndex(options) {
  return new DriveIndex(options);
}

function evenlySpacedIndices(length, budget) {
  if (length <= budget) return Array.from({ length }, (_, index) => index);
  const indices = [];
  const step = (length - 1) / (budget - 1);
  for (let index = 0; index < budget; index++) {
    indices.push(Math.round(index * step));
  }
  return indices;
}

function indexDriveData(index, options = {}) {
  const { onProgress, signal } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  const totalBytes = fs.statSync(index.sourcePath).size;

  return new Promise((resolve, reject) => {
    index.beginIndexing();
    let processedFileCount = 0;
    let routeCount = 0;
    let droppedCount = 0;
    let duplicateCount = 0;
    let routeSequence = 0;
    let driveTags = {};

    let depth = 0;
    let currentTopKey = null;
    let assembler = null;
    let assemblerExitDepth = -1;
    let bytesRead = 0;
    let lastEmit = 0;
    let settled = false;

    const readStream = fs.createReadStream(index.sourcePath);
    const pipeline = chain([
      readStream,
      parser({ packKeys: true, packStrings: true, packNumbers: true }),
    ]);

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      index.rollbackIndexing();
      reject(err);
    };
    const onAbort = () => pipeline.destroy(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    readStream.on('data', (chunk) => {
      bytesRead += chunk.length;
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastEmit >= 100 || bytesRead === totalBytes) {
        lastEmit = now;
        onProgress(bytesRead, totalBytes);
      }
    });

    pipeline.on('data', (token) => {
      if (signal?.aborted) {
        pipeline.destroy(abortError());
        return;
      }
      const name = token.name;
      if (assembler) {
        assembler.consume(token);
        if (name === 'startObject' || name === 'startArray') depth++;
        else if (name === 'endObject' || name === 'endArray') {
          depth--;
          if (depth === assemblerExitDepth) {
            if (currentTopKey === 'routes') {
              const disposition = index.insertRoute(assembler.current, routeSequence++);
              if (disposition === 'inserted') routeCount++;
              else if (disposition === 'duplicate') duplicateCount++;
              else droppedCount++;
            } else if (currentTopKey === 'driveTags') {
              driveTags = assembler.current;
            }
            assembler = null;
          }
        }
        return;
      }

      if (name === 'startObject' || name === 'startArray') {
        const before = depth;
        depth++;
        if (before === 2 && name === 'startObject' && currentTopKey === 'routes') {
          assembler = new Assembler();
          assemblerExitDepth = before;
          assembler.consume(token);
        } else if (before === 1 && name === 'startObject' && currentTopKey === 'driveTags') {
          assembler = new Assembler();
          assemblerExitDepth = before;
          assembler.consume(token);
        }
      } else if (name === 'endObject' || name === 'endArray') {
        depth--;
        if (depth === 1) currentTopKey = null;
      } else if (name === 'keyValue' && depth === 1) {
        currentTopKey = token.value;
      } else if (name === 'stringValue' && depth === 2 && currentTopKey === 'processedFiles') {
        processedFileCount++;
      }
    });

    pipeline.once('end', () => {
      if (settled) return;
      try {
        const counts = { processedFileCount, routeCount, droppedCount, duplicateCount };
        index.setMeta('counts', counts);
        index.setMeta('driveTags', driveTags);
        index.commitIndexing();
        if (onProgress && totalBytes > 0) onProgress(totalBytes, totalBytes);
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(counts);
      } catch (error) {
        finishReject(error);
      }
    });
    pipeline.once('error', finishReject);
  });
}

module.exports = {
  createDriveIndex,
  indexDriveData,
  parseFileTimestampMs,
};
