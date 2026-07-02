// Lightweight app-wide logging.
//
// • Every entry is echoed to the terminal (visible when running `npm start`;
//   packaged builds simply have no console attached).
// • The last MAX_ENTRIES entries live in an in-memory ring buffer that
//   Settings → Support → Logs exports as a .txt file.
// • Nothing is written to disk during normal operation — logs only touch
//   disk when the user explicitly downloads them.
//
// Sources feeding this log:
//   - main-process uncaught exceptions / unhandled rejections
//   - renderer errors, unhandled rejections, and console.error/warn
//     (forwarded over the 'app-log' IPC channel)
//   - auto-updater errors, processing-child lifecycle + stderr
//   - anything else that calls logger.info/warn/error directly

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 5000;     // ring buffer size
const MAX_ENTRY_LEN = 10000;  // per-entry truncation guard
const MAX_FILE_BYTES = 20 * 1024 * 1024; // stop appending past this (runaway-error guard)
const PREV_EXPORT_BYTES = 256 * 1024;    // how much of the previous session to include in exports

const entries = [];
let appInfo = { version: '?' };

// ── Crash-surviving file sink ────────────────────────────────────────────────
// Lines are appended (batched ~1 s; errors flush immediately) to
// <userData>/logs/session.log. On startup the last session's file rotates to
// previous-session.log, so a crashed session's log is always recoverable and
// included in the next export.
let logFile = null;
let prevFile = null;
let fileBytes = 0;
let pendingLines = [];
let flushTimer = null;

function flushNow() {
  if (!logFile || pendingLines.length === 0) return;
  const text = pendingLines.join('\n') + '\n';
  pendingLines = [];
  if (fileBytes >= MAX_FILE_BYTES) return;
  try {
    fs.appendFileSync(logFile, text);
    fileBytes += Buffer.byteLength(text);
    if (fileBytes >= MAX_FILE_BYTES) fs.appendFileSync(logFile, '(log file size cap reached — further entries kept in memory only)\n');
  } catch { /* disk issues must never break the app */ }
}

function initFileSink(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'session.log');
    prevFile = path.join(dir, 'previous-session.log');
    if (fs.existsSync(logFile)) {
      try { fs.rmSync(prevFile, { force: true }); } catch {}
      fs.renameSync(logFile, prevFile);
    }
    fs.writeFileSync(logFile, '');
    fileBytes = 0;
  } catch {
    logFile = null; // fall back to memory-only
  }
}

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Scrub anything privacy-sensitive from EXPORTED logs (the .txt users paste for
// support): API tokens/keys, GPS coordinates, and reverse-geocoded addresses.
// Applied only in getLogText — the live terminal + on-disk session log keep
// full detail for local debugging.
function redact(text) {
  return String(text)
    // tokens / keys / bearer credentials in key:value or key=value form
    .replace(/((?:token|api[_-]?key|apikey|authorization|bearer|secret)"?\s*[:=]\s*"?)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]')
    // GPS coordinate JSON fields (latitude_start, longitude, lat, lng, …)
    .replace(/("(?:lat|lng|latitude|longitude)[a-z_]*"\s*:\s*)"?-?\d+\.\d+"?/gi, '$1[coord]')
    // reverse-geocoded addresses echoed from import APIs
    .replace(/("(?:starting_|ending_)?(?:saved_)?location"\s*:\s*)"[^"]*"/gi, '$1"[location]"')
    // free-standing coordinates: a signed decimal with 4+ fractional digits,
    // not part of a larger number (epoch timestamps, ids stay intact)
    .replace(/(?<![\d.])-?\d{1,3}\.\d{4,}(?!\d)/g, '[coord]');
}

function add(level, scope, args) {
  const text = args.map(fmt).join(' ').slice(0, MAX_ENTRY_LEN);
  const line = `[${ts()}] [${level.toUpperCase().padEnd(5)}] [${scope}] ${text}`;
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);

  if (logFile) {
    pendingLines.push(line);
    if (level === 'error') {
      // Errors flush immediately — a crash may be next.
      clearTimeout(flushTimer);
      flushTimer = null;
      flushNow();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, 1000);
    }
  }
}

module.exports = {
  setAppInfo(info) { appInfo = { ...appInfo, ...info }; },
  initFileSink,
  flushNow,
  info: (scope, ...args) => add('info', scope, args),
  warn: (scope, ...args) => add('warn', scope, args),
  error: (scope, ...args) => add('error', scope, args),
  getLogText() {
    const parts = [
      `Sentry Drive logs — exported ${ts()}`,
      `version ${appInfo.version} | ${process.platform} ${process.arch}` +
        `${appInfo.osBuild ? ` (${appInfo.osBuild})` : ''} | ` +
        `electron ${process.versions.electron ?? 'n/a'} | node ${process.versions.node}`,
      'GPS coordinates, addresses, and any tokens are redacted from this export.',
    ];
    // Tail of the previous session (survives crashes thanks to the file sink).
    try {
      if (prevFile && fs.existsSync(prevFile)) {
        const stat = fs.statSync(prevFile);
        if (stat.size > 0) {
          const fd = fs.openSync(prevFile, 'r');
          const len = Math.min(stat.size, PREV_EXPORT_BYTES);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, stat.size - len);
          fs.closeSync(fd);
          parts.push('─'.repeat(78), `PREVIOUS SESSION${stat.size > len ? ' (tail)' : ''}:`, redact(buf.toString('utf8').trimEnd()));
        }
      }
    } catch { /* export must never fail on the extras */ }
    parts.push('─'.repeat(78), 'CURRENT SESSION:', redact(entries.join('\n')), '');
    return parts.join('\n');
  },
};
