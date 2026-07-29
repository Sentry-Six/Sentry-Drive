import test from 'node:test';
import assert from 'node:assert/strict';
import driveTelemetry from './drive-telemetry.cjs';

const { rollUpDriveTelemetry } = driveTelemetry;

test('rolls every supported telemetry category across a drive', () => {
  assert.deepEqual(rollUpDriveTelemetry([
    {
      file: '2026-07-27/a-front.mp4',
      batteryPctStart: 80, batteryPctEnd: 79.5,
      interiorTempMin: 20, interiorTempMax: 24, exteriorTempAvg: 30,
      hvacRuntimeS: 30, tireFlPsi: 42, tireRlPsi: 43,
      odometerMiStart: 1000, locationNameStart: 'Home',
    },
    {
      file: '2026-07-27/b-front.mp4',
      batteryPctStart: 79.5, batteryPctEnd: 78,
      interiorTempMin: 18, interiorTempMax: 28, exteriorTempAvg: 32,
      hvacRuntimeS: 45, tireFlPsi: 41.5, tireFrPsi: 42.5,
      tireRrPsi: 43.5, odometerMiEnd: 1002.25, locationNameEnd: 'Work',
    },
  ]), {
    batteryPctStart: 80, batteryPctEnd: 78, batteryPctUsed: 2,
    interiorTempMinC: 18, interiorTempMaxC: 28, exteriorTempAvgC: 31,
    hvacRuntimeS: 75, tireFlPsi: 41.5, tireFrPsi: 42.5,
    tireRlPsi: 43, tireRrPsi: 43.5,
    odometerMiStart: 1000, odometerMiEnd: 1002.25, odometerMiDriven: 2.25,
    locationNameStart: 'Home', locationNameEnd: 'Work',
  });
});

test('counts telemetry once when a parent clip appears as multiple subclips', () => {
  assert.deepEqual(rollUpDriveTelemetry([
    { file: '2026-07-27/a-front.mp4', batteryPctStart: 70, batteryPctEnd: 69, exteriorTempAvg: 30, hvacRuntimeS: 30 },
    { file: '2026-07-27/a-front.mp4', batteryPctStart: 70, batteryPctEnd: 69, exteriorTempAvg: 30, hvacRuntimeS: 30 },
  ]), {
    batteryPctStart: 70, batteryPctEnd: 69, batteryPctUsed: 1,
    exteriorTempAvgC: 30, hvacRuntimeS: 30,
  });
});

test('uses the latest available tire reading independently per wheel', () => {
  assert.deepEqual(rollUpDriveTelemetry([
    { file: '2026-07-27/a-front.mp4', tireFlPsi: 40, tireFrPsi: 41, tireRlPsi: 42 },
    { file: '2026-07-27/b-front.mp4', tireFlPsi: 39.5, tireRrPsi: 43 },
  ]), { tireFlPsi: 39.5, tireFrPsi: 41, tireRlPsi: 42, tireRrPsi: 43 });
});

test('omits a negative odometer delta while retaining its endpoints', () => {
  assert.deepEqual(rollUpDriveTelemetry([
    { file: '2026-07-27/a-front.mp4', odometerMiStart: 1002, odometerMiEnd: 1001 },
  ]), { odometerMiStart: 1002, odometerMiEnd: 1001 });
});

test('ignores non-finite and non-number telemetry values', () => {
  assert.deepEqual(rollUpDriveTelemetry([
    {
      file: '2026-07-27/a-front.mp4',
      batteryPctStart: '80', batteryPctEnd: Number.NaN,
      interiorTempMin: Number.POSITIVE_INFINITY, exteriorTempAvg: '30',
      hvacRuntimeS: '60', tireFlPsi: Number.NEGATIVE_INFINITY,
      odometerMiStart: null,
    },
    { file: '2026-07-27/b-front.mp4', batteryPctStart: 79.25, batteryPctEnd: 78.1 },
  ]), { batteryPctStart: 79.25, batteryPctEnd: 78.1, batteryPctUsed: 1.15 });
});

test('returns no optional fields when a drive has no telemetry', () => {
  assert.deepEqual(rollUpDriveTelemetry([{ file: '2026-07-27/a-front.mp4' }]), {});
});
