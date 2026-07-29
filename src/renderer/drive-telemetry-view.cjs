'use strict';

const MI_TO_KM = 1.609344;
const PSI_TO_BAR = 0.0689475729;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fixed(value, decimals, suffix, options = {}) {
  if (!finiteNumber(value)) return '—';
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: options.minimumFractionDigits ?? decimals,
    maximumFractionDigits: decimals,
  })} ${suffix}`;
}

function percent(value, decimals = 0) {
  if (!finiteNumber(value)) return '—';
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

function temperature(value, metric) {
  if (!finiteNumber(value)) return '—';
  const displayed = metric ? value : value * 9 / 5 + 32;
  return fixed(displayed, 1, metric ? '°C' : '°F');
}

function duration(seconds) {
  if (!finiteNumber(seconds)) return '—';
  const totalSeconds = Math.max(0, Math.round(seconds));
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function sectionIfPopulated(title, values, items) {
  return values.some(finiteNumber) ? { title, items } : null;
}

function buildDriveTelemetrySections(drive = {}, unitSystem = 'imperial') {
  const metric = unitSystem === 'metric';
  const sections = [
    sectionIfPopulated(
      'Battery',
      [drive.batteryPctStart, drive.batteryPctEnd, drive.batteryPctUsed],
      [
        { label: 'Start', value: percent(drive.batteryPctStart) },
        { label: 'End', value: percent(drive.batteryPctEnd) },
        { label: 'Used', value: percent(drive.batteryPctUsed, 1) },
      ],
    ),
    sectionIfPopulated(
      'Climate',
      [drive.interiorTempMinC, drive.interiorTempMaxC, drive.exteriorTempAvgC, drive.hvacRuntimeS],
      [
        { label: 'Interior low', value: temperature(drive.interiorTempMinC, metric) },
        { label: 'Interior high', value: temperature(drive.interiorTempMaxC, metric) },
        { label: 'Exterior avg', value: temperature(drive.exteriorTempAvgC, metric) },
        { label: 'HVAC runtime', value: duration(drive.hvacRuntimeS) },
      ],
    ),
    sectionIfPopulated(
      'Tire Pressure',
      [drive.tireFlPsi, drive.tireFrPsi, drive.tireRlPsi, drive.tireRrPsi],
      [
        { label: 'Front left', value: metric ? fixed(drive.tireFlPsi * PSI_TO_BAR, 2, 'bar') : fixed(drive.tireFlPsi, 1, 'psi') },
        { label: 'Front right', value: metric ? fixed(drive.tireFrPsi * PSI_TO_BAR, 2, 'bar') : fixed(drive.tireFrPsi, 1, 'psi') },
        { label: 'Rear left', value: metric ? fixed(drive.tireRlPsi * PSI_TO_BAR, 2, 'bar') : fixed(drive.tireRlPsi, 1, 'psi') },
        { label: 'Rear right', value: metric ? fixed(drive.tireRrPsi * PSI_TO_BAR, 2, 'bar') : fixed(drive.tireRrPsi, 1, 'psi') },
      ],
    ),
    sectionIfPopulated(
      'Odometer',
      [drive.odometerMiStart, drive.odometerMiEnd, drive.odometerMiDriven],
      [
        { label: 'Start', value: fixed(drive.odometerMiStart * (metric ? MI_TO_KM : 1), 1, metric ? 'km' : 'mi') },
        { label: 'End', value: fixed(drive.odometerMiEnd * (metric ? MI_TO_KM : 1), 1, metric ? 'km' : 'mi') },
        { label: 'Driven', value: fixed(drive.odometerMiDriven * (metric ? MI_TO_KM : 1), 1, metric ? 'km' : 'mi') },
      ],
    ),
  ];

  return sections.filter(Boolean);
}

module.exports = Object.freeze({
  buildDriveTelemetrySections,
});
