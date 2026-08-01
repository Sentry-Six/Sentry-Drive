'use strict';

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');
const { chain } = require('stream-chain');
const { parser } = require('stream-json/parser.js');
const AssemblerModule = require('stream-json/assembler.js');
const Assembler = AssemblerModule.Assembler ?? AssemblerModule;
const { DRIVE_GAP_MS, GAP_FILL_MAX_MS } = require('../shared/drive-calc.cjs');
const { parseClipTimestampMs } = require('../shared/event-gap-fill.cjs');
const { normalizeClipPath } = require('../shared/clip-path.cjs');
const {
  createChargingSessionBuilder,
  groupChargingSites,
} = require('../shared/charging-history.cjs');
const parseFileTimestampMs = parseClipTimestampMs;

function abortError() {
  const err = new Error('Drive data indexing canceled');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// Tags are stored as a delimited, case-folded string ("|home|work|") so a
// single LIKE '%|tag|%' matches whole tags only — "work" must not match
// "homework". Filtering has to happen in SQL: the renderer only ever holds
// one page, so filtering there would silently search 250 drives out of
// thousands.
function encodeTagSet(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '';
  const clean = tags
    .map((t) => String(t ?? '').trim().toLowerCase())
    .filter(Boolean);
  return clean.length ? `|${clean.join('|')}|` : '';
}

// Inclusive end date: any timestamp on the end date sorts before the next
// day's bare date string ("2026-07-26T23:59" < "2026-07-27"), so a bare
// `< nextDay` keeps the comparison index-friendly.
function nextDayString(date) {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
        tags TEXT NOT NULL DEFAULT '',
        summary BLOB NOT NULL,
        detail BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drives_start_time
        ON drives(start_time DESC, id DESC);
      CREATE TABLE IF NOT EXISTS charging_sites (
        site_id TEXT PRIMARY KEY,
        visit_count INTEGER NOT NULL,
        latest_visit TEXT,
        summary BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS charging_sites_order
        ON charging_sites(visit_count DESC, latest_visit DESC);
      CREATE TABLE IF NOT EXISTS charging_sessions (
        session_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        start_timestamp REAL NOT NULL,
        summary BLOB NOT NULL,
        detail BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS charging_sessions_site_time
        ON charging_sessions(site_id, start_timestamp DESC);
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
      INSERT INTO drives(id, start_time, source, tags, summary, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.deleteDriveStmt = this.db.prepare('DELETE FROM drives WHERE id = ?');
    this.getDriveDetailStmt = this.db.prepare('SELECT detail FROM drives WHERE id = ?');
    this.insertChargingSiteStmt = this.db.prepare(`
      INSERT INTO charging_sites(site_id, visit_count, latest_visit, summary)
      VALUES (?, ?, ?, ?)
    `);
    this.insertChargingSessionStmt = this.db.prepare(`
      INSERT INTO charging_sessions(session_id, site_id, start_timestamp, summary, detail)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.getChargingSessionStmt = this.db.prepare(
      'SELECT detail FROM charging_sessions WHERE session_id = ?',
    );
  }

  insertRoute(route, sequence) {
    const normalizedFile = normalizeClipPath(route?.file);
    // Event-folder routes are STORED, not dropped: Rusty's gap-fill writes
    // admitted SavedClips/SentryClips clips into drive-data.json, and the
    // grouper decides per-window which ones fill real RecentClips gaps
    // (groupIntoDrives' admission). Their timestamps come from the clip
    // basename via parseFileTimestampMs, so windowing places them correctly.
    if (!normalizedFile) return 'dropped';
    const timestampMs = parseFileTimestampMs(normalizedFile);
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
      chargingSessionCount: 0,
      chargingSiteCount: 0,
    });
  }

  getDriveTags() {
    return this.getMetaValue('driveTags', {});
  }

  clearDrives() {
    this.db.exec('DELETE FROM drives');
  }

  putDrive(summary, detail) {
    // Summon-detected drives get a synthetic "summon" entry in the FILTER
    // column only — summary.tags stays user-authored, so the tag editor
    // never shows (or persists) a pill the user didn't add. A duplicate from
    // a user's own "summon" tag is harmless: the LIKE match is identical.
    const filterTags = summary.summon
      ? [...(summary.tags ?? []), 'summon']
      : summary.tags;
    this.insertDriveStmt.run(
      summary.id,
      summary.startTime,
      summary.source ?? 'sei',
      encodeTagSet(filterTags),
      v8.serialize(summary),
      v8.serialize(detail),
    );
  }

  deleteDrive(id) {
    this.deleteDriveStmt.run(id);
  }

  /**
   * Keep a drive's filterable tags current after an in-session tag edit.
   * The summary blob still carries the tags baked in at index time, but the
   * renderer holds its own updated copy for display — this only has to keep
   * tag FILTERING truthful until the next load rebuilds the index.
   */
  setDriveTags(startTime, tags) {
    // Keep the synthetic summon filter entry (see putDrive) across in-session
    // tag edits — rewriting the column from user tags alone would silently
    // drop a summon drive out of the Summon filter until the next regroup.
    const row = this.db.prepare('SELECT summary FROM drives WHERE start_time = ?')
      .get(String(startTime));
    const isSummon = row ? Boolean(v8.deserialize(row.summary)?.summon) : false;
    const filterTags = isSummon ? [...(tags ?? []), 'summon'] : tags;
    this.db.prepare('UPDATE drives SET tags = ? WHERE start_time = ?')
      .run(encodeTagSet(filterTags), String(startTime));
    const all = this.getDriveTags();
    if (Array.isArray(tags) && tags.length > 0) all[startTime] = tags;
    else delete all[startTime];
    this.setMeta('driveTags', all);
  }

  /**
   * Page through drives, newest first. Optional filters (all default to off,
   * matching the app's unfiltered default):
   *   tag       — only drives carrying this tag (whole-tag match)
   *   startDate — YYYY-MM-DD, inclusive
   *   endDate   — YYYY-MM-DD, inclusive
   * `total` reflects the filtered set, so the pager stays honest.
   */
  listDriveSummaries({ offset = 0, limit = 250, tag = '', startDate = '', endDate = '' } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
    const boundedOffset = Math.max(0, Number(offset) || 0);

    const where = [];
    const params = [];
    const tagTerm = String(tag ?? '').trim().toLowerCase();
    if (tagTerm) {
      where.push('tags LIKE ?');
      params.push(`%|${tagTerm}|%`);
    }
    if (startDate) {
      where.push('start_time >= ?');
      params.push(String(startDate).slice(0, 10));
    }
    if (endDate) {
      const stop = nextDayString(endDate);
      if (stop) {
        where.push('start_time < ?');
        params.push(stop);
      }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS total FROM drives ${clause}`).get(...params).total,
    );
    const rows = this.db.prepare(`
      SELECT summary
      FROM drives
      ${clause}
      ORDER BY start_time DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, boundedLimit, boundedOffset);
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

  putChargingHistory(sites, sessions) {
    for (const site of sites) {
      this.insertChargingSiteStmt.run(
        site.siteId,
        site.visitCount,
        site.latestVisit,
        v8.serialize(site),
      );
    }
    for (const session of sessions) {
      const { chargeRateSamples: _samples, ...summary } = session;
      this.insertChargingSessionStmt.run(
        session.sessionId,
        session.siteId,
        session.startTimestamp,
        v8.serialize(summary),
        v8.serialize(session),
      );
    }
  }

  listChargingSites() {
    return this.db.prepare(`
      SELECT summary
      FROM charging_sites
      ORDER BY visit_count DESC, latest_visit DESC, site_id
    `).all().map((row) => v8.deserialize(row.summary));
  }

  listChargingSessions(siteId) {
    return this.db.prepare(`
      SELECT summary
      FROM charging_sessions
      WHERE site_id = ?
      ORDER BY start_timestamp DESC, session_id DESC
    `).all(siteId).map((row) => v8.deserialize(row.summary));
  }

  getChargingSession(sessionId) {
    const row = this.getChargingSessionStmt.get(sessionId);
    return row ? v8.deserialize(row.detail) : null;
  }

  *iterateTimeWindows() {
    const rows = this.db.prepare(`
      SELECT timestamp_ms, payload
      FROM routes
      ORDER BY timestamp_ms, sequence
    `).iterate();
    // Windows split on gaps wider than the GAP-FILL cap, not DRIVE_GAP_MS:
    // a 9-19 min recording dropout that event pre-rolls can fill must stay
    // inside ONE window or the grouper can never bridge it. groupIntoDrives
    // re-splits at DRIVE_GAP_MS within each window, so files without event
    // routes group exactly as before — the wider window only batches more.
    let window = [];
    let previousMs = null;
    for (const row of rows) {
      if (previousMs != null && row.timestamp_ms - previousMs > GAP_FILL_MAX_MS) {
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
    let chargeCosts = {};
    let chargeTags = {};
    const chargingBuilder = createChargingSessionBuilder();

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
            } else if (currentTopKey === 'telemetrySamples') {
              chargingBuilder.add(assembler.current);
            } else if (currentTopKey === 'driveTags') {
              driveTags = assembler.current;
            } else if (currentTopKey === 'chargeCosts') {
              chargeCosts = assembler.current;
            } else if (currentTopKey === 'chargeTags') {
              chargeTags = assembler.current;
            }
            assembler = null;
          }
        }
        return;
      }

      if (name === 'startObject' || name === 'startArray') {
        const before = depth;
        depth++;
        if (
          before === 2
          && name === 'startObject'
          && (currentTopKey === 'routes' || currentTopKey === 'telemetrySamples')
        ) {
          assembler = new Assembler();
          assemblerExitDepth = before;
          assembler.consume(token);
        } else if (
          before === 1
          && name === 'startObject'
          && (currentTopKey === 'driveTags' || currentTopKey === 'chargeCosts'
            || currentTopKey === 'chargeTags')
        ) {
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
        const charging = groupChargingSites(chargingBuilder.finish(chargeCosts, chargeTags));
        index.putChargingHistory(charging.sites, charging.sessions);
        const counts = {
          processedFileCount,
          routeCount,
          droppedCount,
          duplicateCount,
          chargingSessionCount: charging.sessions.length,
          chargingSiteCount: charging.sites.length,
        };
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
