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

const MAX_ENTRIES = 5000;     // ring buffer size
const MAX_ENTRY_LEN = 10000;  // per-entry truncation guard

const entries = [];
let appInfo = { version: '?' };

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

function add(level, scope, args) {
  const text = args.map(fmt).join(' ').slice(0, MAX_ENTRY_LEN);
  const line = `[${ts()}] [${level.toUpperCase().padEnd(5)}] [${scope}] ${text}`;
  entries.push(line);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);
}

module.exports = {
  setAppInfo(info) { appInfo = { ...appInfo, ...info }; },
  info: (scope, ...args) => add('info', scope, args),
  warn: (scope, ...args) => add('warn', scope, args),
  error: (scope, ...args) => add('error', scope, args),
  getLogText() {
    return [
      `Sentry Drive logs — exported ${ts()}`,
      `version ${appInfo.version} | ${process.platform} ${process.arch} | ` +
        `electron ${process.versions.electron ?? 'n/a'} | node ${process.versions.node}`,
      '─'.repeat(78),
      ...entries,
      '',
    ].join('\n');
  },
};
