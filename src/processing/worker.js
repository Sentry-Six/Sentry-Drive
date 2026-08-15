// Pull-based GPS extraction worker; posting a result requests the next file.
import { parentPort, workerData } from "node:worker_threads";
import { extractGPSFromFile } from "./extract.js";
import { computeGearRuns, computeFlagRuns, computeApRuns } from "../shared/drive-calc.cjs";

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
      const flagRuns = computeFlagRuns(data.flags, data.speeds);
      const apRuns = computeApRuns(data.apStates);
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
          flagRuns,
          apRuns,
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

parentPort.postMessage({ type: "ready", workerId });

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
