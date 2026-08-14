import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChargingSessionBuilder,
  groupChargingSites,
} from './charging-history.cjs';

function collect(samples, costs = {}) {
  const builder = createChargingSessionBuilder();
  for (const sample of samples) builder.add(sample);
  return builder.finish(costs);
}

test('builds a sparse charging session and matches its exact start cost', () => {
  const sessions = collect([
    { ts: 1_000, batteryPct: 20, lat: 39, lng: -77, locationName: 'Old place' },
    { ts: 1_060, chargingState: 'starting' },
    { ts: 1_070, chargerPowerKw: 5, chargeEnergyAddedKwh: 0.2 },
    {
      ts: 1_080,
      lat: 40.1,
      lng: -76.2,
      locationName: 'Market Street',
      chargerPowerKw: 25,
      chargeRateMph: 110,
      batteryPct: 25,
      chargeEnergyAddedKwh: 1.5,
    },
    {
      ts: 1_120,
      lat: 40.1004,
      lng: -76.2003,
      chargerPowerKw: 48,
      batteryPct: 35,
      chargeEnergyAddedKwh: 4.25,
    },
    { ts: 1_180, chargingState: 'complete', batteryPct: 41 },
  ], {
    1060: { amount: 8.75, currency: '$' },
    1059: { amount: 99, currency: '$' },
  });

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    sessionId: 'charge-1060-1',
    startTimestamp: 1_060,
    endTimestamp: 1_180,
    startTime: '1970-01-01T00:17:40.000Z',
    endTime: '1970-01-01T00:19:40.000Z',
    durationSeconds: 120,
    startBatteryPct: 20,
    endBatteryPct: 41,
    energyAddedKwh: 4.25,
    peakPowerKw: 48,
    latitude: 40.1004,
    longitude: -76.2003,
    locationName: 'Market Street',
    endReason: 'complete',
    cost: { amount: 8.75, currency: '$' },
    tags: [],
    chargeRateSamples: [
      {
        timestamp: 1_070,
        powerKw: 5,
        energyAddedKwh: 0.2,
        batteryPct: 20,
      },
      {
        timestamp: 1_080,
        powerKw: 25,
        chargeRateMph: 110,
        energyAddedKwh: 1.5,
        batteryPct: 25,
      },
      {
        timestamp: 1_120,
        powerKw: 48,
        energyAddedKwh: 4.25,
        batteryPct: 35,
      },
    ],
  });
});

test('rejects a short false start without energy or sustained power', () => {
  const sessions = collect([
    { ts: 2_000, chargingState: 'starting' },
    { ts: 2_010, chargingState: 'charging', chargerPowerKw: 3 },
    { ts: 2_025, chargingState: 'stopped', chargerPowerKw: 0 },
  ]);
  assert.deepEqual(sessions, []);
});

test('counts sustained nonzero power even when cumulative energy is absent', () => {
  const sessions = collect([
    { ts: 3_000, chargingState: 'charging', chargerPowerKw: 7 },
    { ts: 3_061, chargingState: 'charging', chargerPowerKw: 6 },
    { ts: 3_080, chargingState: 'disconnected' },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].energyAddedKwh, null);
  assert.equal(sessions[0].endReason, 'disconnected');
});

test('requires one uninterrupted nonzero-power streak', () => {
  const sessions = collect([
    { ts: 3_500, chargingState: 'charging', chargerPowerKw: 7 },
    { ts: 3_540, chargingState: 'charging', chargerPowerKw: 0 },
    { ts: 3_570, chargingState: 'charging', chargerPowerKw: 6 },
    { ts: 3_590, chargingState: 'stopped', chargerPowerKw: 0 },
  ]);
  assert.deepEqual(sessions, []);
});

test('matches a millisecond timestamp cost without changing its lookup key', () => {
  const startMs = 12_000_000_000;
  const sessions = collect([
    { ts: startMs, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
    { ts: startMs + 60_000, chargingState: 'complete' },
  ], {
    [startMs]: { amount: 3.25, currency: '$' },
  });
  assert.equal(sessions[0].startTimestamp, startMs / 1_000);
  assert.deepEqual(sessions[0].cost, { amount: 3.25, currency: '$' });
});

test('closes sessions at a 30 minute gap and at end of file', () => {
  const sessions = collect([
    { ts: 4_000, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
    { ts: 5_801, chargingState: 'charging', chargeEnergyAddedKwh: 2 },
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].endTimestamp, 4_000);
  assert.equal(sessions[0].endReason, 'data-gap');
  assert.equal(sessions[1].endTimestamp, 5_801);
  assert.equal(sessions[1].endReason, 'end-of-file');
});

test('uses only a coordinate fallback observed within 15 minutes before charging', () => {
  const sessions = collect([
    { ts: 5_000, lat: 38, lng: -75, locationName: 'Too old' },
    { ts: 5_901, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
    { ts: 5_920, chargingState: 'complete' },
    { ts: 7_000, lat: 39, lng: -76, locationName: 'Fresh place' },
    { ts: 7_899, chargingState: 'charging', chargeEnergyAddedKwh: 2 },
    { ts: 7_920, chargingState: 'nopower' },
  ]);
  assert.equal(sessions[0].latitude, null);
  assert.equal(sessions[0].longitude, null);
  assert.equal(sessions[1].latitude, 39);
  assert.equal(sessions[1].longitude, -76);
  assert.equal(sessions[1].locationName, 'Fresh place');
});

test('ignores malformed timestamps and ends on every terminal charging state', () => {
  const sessions = collect([
    { ts: 'bad', chargingState: 'charging', chargeEnergyAddedKwh: 99 },
    { ts: 8_000, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
    { ts: 8_010, chargingState: 'stopped' },
    { ts: 9_000, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
    { ts: 9_010, chargingState: 'disconnected' },
    { ts: 10_000, chargingState: 'charging', chargeEnergyAddedKwh: 1 },
    { ts: 10_010, chargingState: 'no-power' },
  ]);
  assert.deepEqual(sessions.map((session) => session.endReason), [
    'stopped',
    'disconnected',
    'nopower',
  ]);
});

test('groups repeated visits within 150 metres and keeps unknown sessions listable', () => {
  const makeSession = (sessionId, startTimestamp, latitude, longitude, locationName) => ({
    sessionId,
    startTimestamp,
    startTime: new Date(startTimestamp * 1_000).toISOString(),
    endTimestamp: startTimestamp + 60,
    latitude,
    longitude,
    locationName,
  });
  const grouped = groupChargingSites([
    makeSession('a', 100, 40, -76, 'First label'),
    makeSession('b', 300, 40.0007, -76.0004, 'New label'),
    makeSession('c', 200, 40.003, -76, 'Nearby but distinct'),
    makeSession('d', 400, null, null, 'Garage'),
  ]);

  assert.deepEqual(grouped.sites.map((site) => ({
    siteId: site.siteId,
    displayName: site.displayName,
    visitCount: site.visitCount,
    latestVisit: site.latestVisit,
    latitude: site.latitude,
  })), [
    {
      siteId: 'site-a',
      displayName: 'New label',
      visitCount: 2,
      latestVisit: '1970-01-01T00:05:00.000Z',
      latitude: 40.00035,
    },
    {
      siteId: 'unknown',
      displayName: 'Unknown location',
      visitCount: 1,
      latestVisit: '1970-01-01T00:06:40.000Z',
      latitude: null,
    },
    {
      siteId: 'site-c',
      displayName: 'Nearby but distinct',
      visitCount: 1,
      latestVisit: '1970-01-01T00:03:20.000Z',
      latitude: 40.003,
    },
  ]);
  assert.deepEqual(
    grouped.sessions.filter((session) => session.siteId === 'site-a')
      .map((session) => session.sessionId),
    ['b', 'a'],
  );
});

test('charge tags attach by session start key and mark a site as home', () => {
  const builder = createChargingSessionBuilder();
  const samples = [
    { ts: 1_000, lat: 40, lng: -76, locationName: 'Driveway', batteryPct: 20 },
    { ts: 1_010, chargingState: 'charging', chargerPowerKw: 7, chargeEnergyAddedKwh: 0.5 },
    { ts: 1_120, chargingState: 'complete', batteryPct: 40 },
    { ts: 9_000, lat: 40, lng: -76, locationName: 'Driveway', batteryPct: 30 },
    { ts: 9_010, chargingState: 'charging', chargerPowerKw: 7, chargeEnergyAddedKwh: 0.5 },
    { ts: 9_120, chargingState: 'complete', batteryPct: 50 },
    { ts: 90_000, lat: 41, lng: -77, locationName: 'Supercharger', batteryPct: 20 },
    { ts: 90_010, chargingState: 'charging', chargerPowerKw: 150, chargeEnergyAddedKwh: 5 },
    { ts: 90_120, chargingState: 'complete', batteryPct: 60 },
  ];
  for (const sample of samples) builder.add(sample);

  const sessions = builder.finish({}, {
    1_010: ['HOME'],
    90_010: ['Road Trip'],
  });
  assert.deepEqual(sessions.map((s) => s.tags).sort(), [[], ['HOME'], ['Road Trip']].sort());

  const { sites } = groupChargingSites(sessions);
  const driveway = sites.find((site) => site.displayName === 'Driveway');
  const away = sites.find((site) => site.displayName === 'Supercharger');

  assert.equal(driveway.visitCount, 2);
  assert.deepEqual(driveway.tags, ['HOME']);
  assert.equal(driveway.isHome, true);
  assert.deepEqual(away.tags, ['Road Trip']);
  assert.equal(away.isHome, false);
});

test('a scalar charge tag is accepted, and no tags means no home flag', () => {
  const build = (tagMap) => {
    const builder = createChargingSessionBuilder();
    for (const sample of [
      { ts: 1_000, lat: 40, lng: -76, locationName: 'Spot', batteryPct: 20 },
      { ts: 1_010, chargingState: 'charging', chargerPowerKw: 7, chargeEnergyAddedKwh: 0.5 },
      { ts: 1_120, chargingState: 'complete', batteryPct: 40 },
    ]) builder.add(sample);
    return groupChargingSites(builder.finish({}, tagMap)).sites[0];
  };

  assert.equal(build({ 1_010: 'Home' }).isHome, true);
  assert.equal(build({ 1_010: ['  home  '] }).isHome, true);
  assert.equal(build({}).isHome, false);
  assert.deepEqual(build({}).tags, []);
  assert.equal(build({ 5_555: ['Home'] }).isHome, false);
});

test('site summary carries the fastest charge recorded there', () => {
  const session = (sessionId, startTimestamp, peakPowerKw) => ({
    sessionId,
    startTimestamp,
    startTime: new Date(startTimestamp * 1_000).toISOString(),
    endTimestamp: startTimestamp + 60,
    latitude: 40,
    longitude: -76,
    locationName: 'Spot',
    peakPowerKw,
  });
  const { sites } = groupChargingSites([
    session('a', 100, 7),
    session('b', 200, 142),
    session('c', 300, 48),
  ]);
  assert.equal(sites[0].peakPowerKw, 142);

  const { sites: partial } = groupChargingSites([
    session('a', 100, null),
    session('b', 200, 11),
  ]);
  assert.equal(partial[0].peakPowerKw, 11);

  const { sites: none } = groupChargingSites([session('a', 100, null)]);
  assert.equal(none[0].peakPowerKw, null);
});
