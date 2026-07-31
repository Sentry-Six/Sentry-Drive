#!/usr/bin/env node
// process.js - Main entry point for drives processing
// Replicates Sentry USB drives processing for Z:\RecentClips
// Uses worker threads for parallel extraction across all CPU cores

import { Worker } from "node:worker_threads";
import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { groupIntoDrives, encodeByteField } from "./grouper.js";
import { discoverProcessingFiles } from "./clip-discovery.js";
import processResult from "./process-result.cjs";
import clipPath from "../shared/clip-path.cjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { buildProcessedRoute } = processResult;
const { normalizeClipPath } = clipPath;
const { writeDriveDataJSON } = createRequire(import.meta.url)("../main/drive-data-writer.cjs");

// Large-file-safe reader shared with the main process (native JSON.parse under
// V8's string cap, stream-json above it). Loaded defensively: it pulls in
// stream-chain/stream-json, and this child runs as plain Node in packaged
// builds (ELECTRON_RUN_AS_NODE — no asar support), so the module and those
// deps must be asarUnpacked (see package.json build.asarUnpack). If the
// require ever fails, fall back to the plain readFile path below — the
// ENOENT-only fresh-start rule still protects the existing file either way.
let readDriveData = null;
try {
  ({ readDriveData } = createRequire(import.meta.url)("../main/drive-data-reader.cjs"));
} catch { /* fall back to readFile + JSON.parse */ }

const rawArgs = process.argv.slice(2);
const REPROCESS_ALL = rawArgs.includes("--reprocess-all");
const positional = rawArgs.filter((a) => !a.startsWith("--"));

const CLIPS_DIR = positional[0] || "Z:\\RecentClips";
const OUTPUT_PATH = positional[1] || path.join(__dirname, "..", "..", "drive-data.json");
const NUM_WORKERS = positional[2]
  ? Math.max(1, parseInt(positional[2], 10))
  : Math.max(1, os.cpus().length - 1);

// Only process clips on or after this date (YYYY-MM-DD, inclusive).
const CUTOFF_DATE = "2025-12-01";

// Shared-queue worker pool: every worker pulls the next file when it finishes
// its current one, so all workers stay busy until the queue is empty. The old
// up-front round-robin split left finished workers idle while the slowest
// chunk's worker ground through its tail alone.
function runWorkerPool(files, numWorkers, onResult) {
  let nextIdx = 0;
  const promises = [];
  for (let w = 0; w < numWorkers; w++) {
    promises.push(new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "worker.js"), {
        workerData: { workerId: w },
      });
      const sendNext = () => {
        if (nextIdx < files.length) {
          worker.postMessage({ type: "file", file: files[nextIdx++] });
        } else {
          worker.postMessage({ type: "end" });
        }
      };
      worker.on("message", (msg) => {
        if (msg.type === "ready") {
          sendNext();
        } else if (msg.type === "result") {
          onResult(msg);
          sendNext();
        } else if (msg.type === "done") {
          resolve();
        }
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) reject(new Error(`Worker ${w} exited with code ${code}`));
      });
    }));
  }
  return Promise.all(promises);
}

async function main() {
  const startTime = Date.now();
  console.log(`Drives Processor - Replicating Sentry USB drives processing`);
  console.log(`Clips directory: ${CLIPS_DIR}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Workers: ${NUM_WORKERS}`);
  console.log(`Cutoff: ${CUTOFF_DATE} (front camera only)`);
  console.log();

  // Sweep stale temp files from crashed or killed runs — the atomic writer
  // renames its tmp away on success, so anything still matching the pattern
  // is dead weight from an interrupted write.
  try {
    const outDir = path.dirname(OUTPUT_PATH);
    const outBase = path.basename(OUTPUT_PATH);
    for (const f of await readdir(outDir)) {
      if (f.startsWith(`${outBase}.`) && f.endsWith('.tmp')) {
        await unlink(path.join(outDir, f)).catch(() => {});
      }
    }
  } catch {
    // Output dir may not exist yet — the writer creates the file later.
  }

  // Load existing data if available (for incremental processing).
  // In --reprocess-all mode we still read the file so user-authored driveTags
  // survive a reprocess, but processedFiles/routes are discarded so every
  // clip is re-extracted.
  let existingData = { processedFiles: [], routes: [], driveTags: {} };
  try {
    let loaded;
    if (readDriveData) {
      // Shared large-file-safe reader — handles libraries past V8's string cap.
      loaded = await readDriveData(OUTPUT_PATH, { wantProcessedFiles: true });
    } else {
      loaded = JSON.parse(await readFile(OUTPUT_PATH, "utf-8"));
    }
    if (REPROCESS_ALL) {
      existingData = { processedFiles: [], routes: [], driveTags: loaded.driveTags || {} };
      console.log(`Reprocess-all mode: discarding ${loaded.processedFiles?.length || 0} processed files / ${loaded.routes?.length || 0} routes (preserving ${Object.keys(loaded.driveTags || {}).length} drive tags)`);
    } else {
      existingData = loaded;
      console.log(`Loaded existing data: ${existingData.processedFiles?.length || 0} processed files, ${existingData.routes?.length || 0} routes`);
    }
  } catch (err) {
    // Only a MISSING file means "fresh start". Any other failure (a file too
    // large for V8's string cap, corrupt JSON, a permission error) used to be
    // swallowed here too — and the final save would then rewrite the file
    // WITHOUT the old routes, imported drives, or tags. Abort instead: the
    // existing drive-data.json is left untouched.
    if (err.code !== "ENOENT") {
      console.error(`Failed to read existing ${OUTPUT_PATH}: ${err.message}`);
      console.error("Aborting so the existing drive data is not overwritten.");
      process.exit(1);
    }
    // No existing data, start fresh
  }

  const processedSet = new Set();
  if (existingData.processedFiles) {
    for (const f of existingData.processedFiles) {
      processedSet.add(normalizeClipPath(f));
    }
  }

  // Discover files
  console.log("Scanning for front camera clips...");
  const discovery = await discoverProcessingFiles(CLIPS_DIR, {
    cutoffDate: CUTOFF_DATE,
    processedFiles: existingData.processedFiles ?? [],
    onProgress: ({ current, total }) => {
      if (total > 0) process.stdout.write(`\rSCAN ${current}/${total}`);
    },
  });
  const allFiles = discovery.files;
  if (discovery.recentCount > 0) process.stdout.write('\n');
  console.log(`Found ${discovery.recentCount} RecentClips front camera clips` +
    `${discovery.gapFillCount > 0 ? ` + ${discovery.gapFillCount} event gap-fill candidate(s)` : ''}`);

  // Filter already processed
  const newFiles = allFiles.filter((f) => !processedSet.has(f.relativePath));
  console.log(`New files to process: ${newFiles.length}`);

  if (newFiles.length === 0) {
    console.log("\nNo new files to process.");
    if (existingData.routes && existingData.routes.length > 0) {
      const { drives, timeGroupCount } = groupIntoDrives(existingData.routes);
      console.log(`Existing drives: ${drives.length} (from ${timeGroupCount} time groups)`);
    }
    return;
  }

  const poolSize = Math.max(1, Math.min(NUM_WORKERS, newFiles.length));
  console.log(`\nProcessing ${newFiles.length} files across ${poolSize} workers (shared queue)...\n`);

  // Shared state for incremental result collection
  let filesWithGPS = 0;
  let totalPoints = 0;
  let errors = 0;
  let parkedEventSkipped = 0;
  let totalDone = 0;

  // Time-based checkpoints. The old every-100-files policy rewrote the whole
  // (growing) dataset more and more often relative to runtime — O(N²) total
  // checkpoint I/O that could rival the extraction itself on big libraries.
  // One write per minute keeps crash-loss bounded at ~60s of work regardless
  // of library size. `checkpointBusy` guarantees checkpoints never overlap
  // each other; `pendingCheckpoint` lets the final save wait for the last one.
  const CHECKPOINT_MS = 60_000;
  let lastCheckpointMs = Date.now();
  let checkpointBusy = false;
  let pendingCheckpoint = null;

  const processedFiles = [...new Set(
    (existingData.processedFiles || []).map(normalizeClipPath),
  )];
  const routeMap = new Map();

  if (existingData.routes) {
    for (const r of existingData.routes) {
      const normalizedFile = normalizeClipPath(r.file);
      routeMap.set(normalizedFile, { ...r, file: normalizedFile });
    }
  }

  const driveTags = existingData.driveTags || {};

  // Called by each worker for every file result
  const onResult = ({ result }) => {
    totalDone++;

    const processed = buildProcessedRoute(result);
    processedFiles.push(processed.processedPath);

    if (result.error) {
      errors++;
    } else if (processed.parkedEventSkipped) {
      parkedEventSkipped++;
    } else if (processed.route) {
      filesWithGPS++;
      totalPoints += processed.route.points.length;
      routeMap.set(processed.processedPath, processed.route);
    }

    // Progress display
    const pct = Math.round((totalDone / newFiles.length) * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = totalDone > 0 ? (totalDone / ((Date.now() - startTime) / 1000)).toFixed(0) : 0;
    process.stdout.write(`\r  Progress: ${totalDone}/${newFiles.length} (${pct}%) | ${rate} files/sec | ${elapsed}s elapsed`);

    // Checkpoint periodically (time-based, never overlapping)
    if (!checkpointBusy && Date.now() - lastCheckpointMs >= CHECKPOINT_MS) {
      checkpointBusy = true;
      const routes = Array.from(routeMap.values());
      const doneAt = totalDone;
      pendingCheckpoint = streamWriteJSON(OUTPUT_PATH, processedFiles, routes, driveTags)
        .then(() => console.log(`\n  Checkpoint saved (${doneAt} files)`))
        .catch(() => {})
        .finally(() => {
          lastCheckpointMs = Date.now();
          checkpointBusy = false;
        });
    }
  };

  // Run the shared-queue pool
  await runWorkerPool(newFiles, poolSize, onResult);

  // A checkpoint that fired on one of the last files can still be writing.
  // Wait it out: the final save below must be the LAST writer, both so the
  // two never interleave and so a stale checkpoint can't land on top of the
  // complete final file. (Skipping this once crashed the final rename with
  // ENOENT when the checkpoint consumed the shared tmp file first.)
  if (pendingCheckpoint) await pendingCheckpoint;

  const routes = Array.from(routeMap.values());

  console.log(`\n\nExtraction complete:`);
  console.log(`  Files processed: ${totalDone}`);
  console.log(`  Files with GPS:  ${filesWithGPS}`);
  console.log(`  Total points:    ${totalPoints}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  Parked event gap-fill clips skipped: ${parkedEventSkipped}`);

  // Group into drives
  console.log("\nGrouping into drives...");
  const { drives, timeGroupCount, droppedCount } = groupIntoDrives(routes);
  console.log(`  Drives found: ${drives.length} (from ${timeGroupCount} time groups, ${routes.length} routes)`);
  if (droppedCount > 0) console.log(`  Routes without timestamps (dropped): ${droppedCount}`);

  // Compute aggregate stats
  let totalDistKm = 0, totalDistMi = 0, totalDurMs = 0;
  let totalFsdMs = 0, totalFsdKm = 0, totalFsdMi = 0;
  let totalDisengagements = 0, totalAccelPushes = 0;

  for (const d of drives) {
    totalDistKm += d.distanceKm;
    totalDistMi += d.distanceMi;
    totalDurMs += d.durationMs;
    totalFsdMs += d.fsdEngagedMs;
    totalFsdKm += d.fsdDistanceKm;
    totalFsdMi += d.fsdDistanceMi;
    totalDisengagements += d.fsdDisengagements;
    totalAccelPushes += d.fsdAccelPushes;
  }

  console.log(`\nAggregate Statistics:`);
  console.log(`  Total drives:       ${drives.length}`);
  console.log(`  Total routes:       ${routes.length}`);
  console.log(`  Total distance:     ${totalDistMi.toFixed(1)} mi / ${totalDistKm.toFixed(1)} km`);
  console.log(`  Total duration:     ${(totalDurMs / 3600000).toFixed(1)} hours`);
  console.log(`  FSD engaged:        ${(totalFsdMs / 3600000).toFixed(1)} hours`);
  console.log(`  FSD distance:       ${totalFsdMi.toFixed(1)} mi / ${totalFsdKm.toFixed(1)} km`);
  console.log(`  FSD %:              ${totalDistKm > 0 ? (totalFsdKm / totalDistKm * 100).toFixed(1) : 0}%`);
  console.log(`  Disengagements:     ${totalDisengagements}`);
  console.log(`  Accel pushes:       ${totalAccelPushes}`);

  // Save drive-data.json (same format as Sentry USB)
  // Stream JSON to disk to avoid exceeding Node's max string length on large datasets
  console.log(`\nSaving to ${OUTPUT_PATH}...`);
  await streamWriteJSON(OUTPUT_PATH, processedFiles, routes, driveTags);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  // Single machine-readable line the main process lifts into the app log
  // (Settings → Support → Logs), so a crash log still shows the outcome.
  const noSei = totalDone - filesWithGPS;
  console.log(`SUMMARY: scanned ${totalDone} clip(s) → ${drives.length} drive(s)` +
    `${noSei > 0 ? `, ${noSei} without GPS` : ''}${errors > 0 ? `, ${errors} error(s)` : ''}` +
    `${parkedEventSkipped > 0 ? `, ${parkedEventSkipped} parked event candidate(s) skipped` : ''}` +
    `${droppedCount > 0 ? `, ${droppedCount} dropped` : ''} in ${elapsed}s`);
}

function routeForDisk(r) {
  return {
    ...r,
    autopilotStates: encodeByteField(r.autopilotStates),
    gearStates: encodeByteField(r.gearStates),
  };
}

// Atomic + backpressure-aware: write to a temp file and rename over the
// target, so a crash mid-checkpoint can't leave a truncated drive-data.json
// and concurrent readers never see a half-written file. Honoring `drain`
// keeps memory flat instead of buffering the whole serialized dataset.
// The tmp name carries a per-call sequence number: a pid-only name once let
// an overlapping checkpoint and final save share (and corrupt) one tmp file,
// crashing the rename with ENOENT when the other call consumed it first.
async function streamWriteJSON(filePath, processedFiles, routes, driveTags) {
  return writeDriveDataJSON(filePath, {
    processedFiles,
    routes,
    driveTags,
  }, {
    routeTransform: routeForDisk,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
