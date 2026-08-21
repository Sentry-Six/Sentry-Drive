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

// Clip filenames carry the car's local wall clock with no zone marker, and the
// offset-less parse below deliberately interprets them in THIS machine's local
// zone. That assumption is load-bearing across the pipeline: import overlap
// detection parses drive startTime strings the same way to compare against
// true-epoch Tessie/Teslascope times, and synthetic import clips format their
// filenames back through local time to match (see tessie-import.cjs). Parsing
// as UTC here would silently shift every SEI epoch against imported epochs.
// Known residual: on fall-back night the car writes the 01:00-01:59 hour twice
// and both passes parse to the same epochs — the filename clock destroys that
// hour's ordering, so no parser can recover it. Spring-forward is fine: the
// car's clock skips the hour, and local parsing maps the 01:59→03:00 filename
// seam to its true one-minute gap.
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
