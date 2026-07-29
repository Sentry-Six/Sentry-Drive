'use strict';

const FILE_TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;

function normalizeClipPath(file) {
  const normalized = String(file ?? '').replace(/\\/g, '/');
  const rest = normalized.startsWith('RecentClips/')
    ? normalized.slice('RecentClips/'.length)
    : '';
  return rest ? rest : normalized;
}

function isEventFolderPath(file) {
  const normalized = normalizeClipPath(file);
  return normalized.startsWith('SavedClips/') || normalized.startsWith('SentryClips/');
}

function parseClipTimestampMs(file) {
  const normalized = normalizeClipPath(file);
  const filename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const match = FILE_TIMESTAMP_RE.exec(filename);
  if (!match) return null;
  const value = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`).getTime();
  return Number.isFinite(value) ? value : null;
}

module.exports = Object.freeze({
  normalizeClipPath,
  isEventFolderPath,
  parseClipTimestampMs,
});
