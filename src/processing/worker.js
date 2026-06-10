// worker.js - Worker thread for parallel GPS extraction.
//
// Pull model: the coordinator sends one file at a time and we ask for the
// next by posting our result. This keeps all workers busy until the very
// last file — the old pre-chunked split left finished workers idle while
// the unluckiest one ground through its remaining chunk alone.
import { parentPort, workerData } from "node:worker_threads";
import { extractGPSFromFile } from "./extract.js";

const { workerId } = workerData;

parentPort.on("message", async (msg) => {
  if (msg.type === "end") {
    parentPort.postMessage({ type: "done", workerId });
    parentPort.close();
    return;
  }
  if (msg.type !== "file") return;

  const f = msg.file;
  let result;
  try {
    const data = await extractGPSFromFile(f.fullPath);
    if (data && data.points.length > 0) {
      const gearRuns = computeGearRuns(data.gears);
      const rawFrameCount = data.gears.length;
      let rawParkCount = 0;
      for (const g of data.gears) {
        if (g === 0) rawParkCount++;
      }

      const deduped = deduplicatePoints(
        data.points, data.gears, data.apStates, data.speeds, data.accelPositions
      );

      if (deduped.points.length > 0) {
        result = {
          relativePath: f.relativePath,
          dateDir: f.dateDir,
          points: deduped.points,
          gearStates: deduped.gears,
          autopilotStates: deduped.apStates,
          speeds: deduped.speeds,
          accelPositions: deduped.accelPositions,
          rawParkCount,
          rawFrameCount,
          gearRuns,
          hasGPS: true,
        };
      } else {
        result = { relativePath: f.relativePath, hasGPS: false };
      }
    } else {
      result = { relativePath: f.relativePath, hasGPS: false };
    }
  } catch (err) {
    result = { relativePath: f.relativePath, hasGPS: false, error: err.message };
  }

  parentPort.postMessage({ type: "result", workerId, result });
});

// Announce readiness — the coordinator answers with the first file.
parentPort.postMessage({ type: "ready", workerId });

function computeGearRuns(gears) {
  if (gears.length === 0) return [];
  const runs = [];
  let currentGear = gears[0];
  let count = 1;
  for (let i = 1; i < gears.length; i++) {
    if (gears[i] === currentGear) {
      count++;
    } else {
      runs.push({ gear: currentGear, frames: count });
      currentGear = gears[i];
      count = 1;
    }
  }
  runs.push({ gear: currentGear, frames: count });
  return runs;
}

function deduplicatePoints(points, gears, apStates, speeds, accelPositions) {
  if (points.length === 0) return { points: [], gears: [], apStates: [], speeds: [], accelPositions: [] };

  const dp = [points[0]];
  const dg = [gears[0]];
  const da = [apStates[0]];
  const ds = [speeds[0]];
  const dac = [accelPositions[0]];

  for (let i = 1; i < points.length; i++) {
    if (points[i][0] !== points[i - 1][0] || points[i][1] !== points[i - 1][1]) {
      dp.push(points[i]);
      dg.push(gears[i]);
      da.push(apStates[i]);
      ds.push(speeds[i]);
      dac.push(accelPositions[i]);
    }
  }

  return { points: dp, gears: dg, apStates: da, speeds: ds, accelPositions: dac };
}
