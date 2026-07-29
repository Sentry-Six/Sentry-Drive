import test from 'node:test';
import assert from 'node:assert/strict';
import driveTelemetryView from './drive-telemetry-view.cjs';

const { buildDriveTelemetrySections } = driveTelemetryView;

const completeDrive = {
  durationMs: 120000,
  batteryPctStart: 80,
  batteryPctEnd: 78,
  batteryPctUsed: 2,
  interiorTempMinC: 18,
  interiorTempMaxC: 28,
  exteriorTempAvgC: 31,
  hvacRuntimeS: 75,
  tireFlPsi: 40,
  tireFrPsi: 41,
  odometerMiStart: 1000,
  odometerMiEnd: 1002.25,
  odometerMiDriven: 2.25,
};

test('formats complete telemetry in imperial units', () => {
  const sections = buildDriveTelemetrySections(completeDrive, 'imperial');
  assert.deepEqual(sections.map((section) => section.title), [
    'Battery', 'Climate', 'Tire Pressure', 'Odometer',
  ]);
  assert.deepEqual(sections[0].items.map((item) => item.value), ['80%', '78%', '2.0%']);
  assert.deepEqual(sections[1].items.map((item) => item.value), [
    '64.4 °F', '82.4 °F', '87.8 °F', '1m 15s',
  ]);
  assert.deepEqual(sections[2].items.map((item) => item.value), ['40.0 psi', '41.0 psi', '—', '—']);
  assert.deepEqual(sections[3].items.map((item) => item.value), [
    '1,000.0 mi', '1,002.3 mi', '2.3 mi',
  ]);
});

test('formats pressure and odometer telemetry in metric units', () => {
  const sections = buildDriveTelemetrySections(completeDrive, 'metric');
  assert.equal(sections[2].items[0].value, '2.76 bar');
  assert.equal(sections[3].items[0].value, '1,609.3 km');
});

test('returns no sections when telemetry is absent', () => {
  assert.deepEqual(buildDriveTelemetrySections({ durationMs: 60000 }, 'imperial'), []);
});

test('uses an em dash for missing siblings in a populated section', () => {
  assert.deepEqual(buildDriveTelemetrySections({ tireRrPsi: 43 }, 'imperial'), [{
    title: 'Tire Pressure',
    items: [
      { label: 'Front left', value: '—' },
      { label: 'Front right', value: '—' },
      { label: 'Rear left', value: '—' },
      { label: 'Rear right', value: '43.0 psi' },
    ],
  }]);
});

test('omits empty sections and never emits source-provided strings', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const sections = buildDriveTelemetrySections({
    batteryPctEnd: 75,
    locationNameStart: hostile,
    tireFlPsi: hostile,
  }, 'imperial');
  assert.deepEqual(sections.map((section) => section.title), ['Battery']);
  assert.ok(!JSON.stringify(sections).includes(hostile));
});
