import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import clipPath from '../shared/clip-path.cjs';
import eventGapFill from '../shared/event-gap-fill.cjs';

const {
  normalizeClipPath,
  isEventFolderPath,
  parseClipTimestampMs,
} = clipPath;
const { selectGapFill } = eventGapFill;
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveRoots(clipsDir) {
  const resolved = path.resolve(clipsDir);
  if (path.basename(resolved).toLowerCase() === 'recentclips') {
    return {
      recentRoot: resolved,
      teslaCamRoot: path.dirname(resolved),
    };
  }

  const nestedRecent = path.join(resolved, 'RecentClips');
  if (await isDirectory(nestedRecent)) {
    return {
      recentRoot: nestedRecent,
      teslaCamRoot: resolved,
    };
  }

  return {
    recentRoot: resolved,
    teslaCamRoot: resolved,
  };
}

async function walkFrontFiles(root, {
  cutoffDate,
  relativeTo,
  skipEventDirs,
  optional,
}) {
  const files = [];
  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (optional) return files;
    throw error;
  }

  async function walk(dir, entries) {
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          skipEventDirs
          && (entry.name === 'SavedClips' || entry.name === 'SentryClips')
        ) {
          continue;
        }
        let children;
        try {
          children = await readdir(fullPath, { withFileTypes: true });
        } catch {
          continue;
        }
        await walk(fullPath, children);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('-front.mp4')) continue;
      const dateDir = entry.name.slice(0, 10);
      if (!DATE_PREFIX_RE.test(dateDir) || dateDir < cutoffDate) continue;
      const relativePath = normalizeClipPath(path.relative(relativeTo, fullPath));
      const timestampMs = parseClipTimestampMs(relativePath);
      if (timestampMs == null) continue;
      files.push({
        relativePath,
        fullPath,
        dateDir,
        timestampMs,
      });
    }
  }

  await walk(root, rootEntries);
  files.sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.relativePath.localeCompare(right.relativePath)
  ));
  return files;
}

export async function discoverProcessingFiles(clipsDir, {
  cutoffDate,
  processedFiles = [],
  onProgress = () => {},
} = {}) {
  if (!cutoffDate) throw new TypeError('cutoffDate is required');
  const { recentRoot, teslaCamRoot } = await resolveRoots(clipsDir);
  const recentFiles = await walkFrontFiles(recentRoot, {
    cutoffDate,
    relativeTo: recentRoot,
    skipEventDirs: true,
    optional: false,
  });
  onProgress({ current: recentFiles.length, total: recentFiles.length });

  const processed = new Set(processedFiles.map(normalizeClipPath));
  const recentMs = recentFiles.map((file) => file.timestampMs);
  for (const file of processed) {
    if (isEventFolderPath(file)) continue;
    const timestampMs = parseClipTimestampMs(file);
    if (timestampMs != null) recentMs.push(timestampMs);
  }
  recentMs.sort((a, b) => a - b);
  const recentSortedMs = recentMs.filter((timestampMs, index) => (
    index === 0 || timestampMs !== recentMs[index - 1]
  ));

  const eventFiles = [];
  for (const folder of ['SavedClips', 'SentryClips']) {
    const found = await walkFrontFiles(path.join(teslaCamRoot, folder), {
      cutoffDate,
      relativeTo: teslaCamRoot,
      skipEventDirs: false,
      optional: true,
    });
    for (const file of found) {
      if (!processed.has(file.relativePath)) eventFiles.push(file);
    }
  }
  eventFiles.sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.relativePath.localeCompare(right.relativePath)
  ));

  const candidates = eventFiles.map((file) => ({
    timestampMs: file.timestampMs,
    file: file.relativePath,
  }));
  const gapFillFiles = selectGapFill(recentSortedMs, candidates)
    .map((candidateIndex) => eventFiles[candidateIndex]);
  const files = recentFiles.concat(gapFillFiles);
  files.sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.relativePath.localeCompare(right.relativePath)
  ));

  return {
    files: files.map(({ timestampMs: _timestampMs, ...file }) => file),
    recentCount: recentFiles.length,
    gapFillCount: gapFillFiles.length,
  };
}
