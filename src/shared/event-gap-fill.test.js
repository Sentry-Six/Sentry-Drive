import test from 'node:test';
import assert from 'node:assert/strict';
import gapFill from './event-gap-fill.cjs';

const {
  isEventFolderPath,
  parseClipTimestampMs,
  telemetryHasDriving,
  selectGapFill,
} = gapFill;

const ts = (value) => new Date(value).getTime();

test('parseClipTimestampMs reads the clip filename instead of the event-folder timestamp', () => {
  assert.equal(
    parseClipTimestampMs(
      'SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4',
    ),
    ts('2026-07-27T14:02:02'),
  );
  assert.equal(
    parseClipTimestampMs('2026-07-27/2026-07-27_14-01-02-front.mp4'),
    ts('2026-07-27T14:01:02'),
  );
  assert.equal(parseClipTimestampMs('SavedClips/no-timestamp/front.mp4'), null);
});

test('isEventFolderPath recognizes only top-level Tesla event folders', () => {
  assert.equal(isEventFolderPath('SavedClips/event/clip.mp4'), true);
  assert.equal(isEventFolderPath('SentryClips\\event\\clip.mp4'), true);
  assert.equal(isEventFolderPath('foo/SavedClips/event/clip.mp4'), false);
  assert.equal(isEventFolderPath('RecentClips/clip.mp4'), false);
});

test('telemetryHasDriving requires positive gear, legacy-frame, or speed evidence', () => {
  assert.equal(telemetryHasDriving({ gearRuns: [{ gear: 1, frames: 60 }] }), true);
  assert.equal(
    telemetryHasDriving({
      gearStates: Buffer.from([0, 1]).toString('base64'),
    }),
    true,
  );
  assert.equal(
    telemetryHasDriving({
      gearRuns: [{ gear: 0, frames: 60 }],
      gearStates: [0, 0],
      speeds: [0, 0.2],
      rawParkCount: 60,
      rawFrameCount: 60,
    }),
    false,
  );
  assert.equal(telemetryHasDriving({ speeds: [-2] }), true);
  assert.equal(telemetryHasDriving({ rawParkCount: 40, rawFrameCount: 60 }), true);
  assert.equal(telemetryHasDriving({}), false);
});

test('selectGapFill admits an interior driving minute and suppresses occupied/twin rows', () => {
  const recent = [
    ts('2026-06-01T10:00:00'),
    ts('2026-06-01T10:02:00'),
  ];
  const candidates = [
    {
      timestampMs: ts('2026-06-01T10:01:00'),
      file: 'SavedClips/event/2026-06-01_10-01-00-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T10:01:01'),
      file: 'SentryClips/event/2026-06-01_10-01-01-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T10:02:05'),
      file: 'SavedClips/event/2026-06-01_10-02-05-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T10:01:30'),
      file: 'SavedClips/event/2026-06-01_10-01-30-front.mp4',
      driving: false,
    },
  ];

  assert.deepEqual(selectGapFill(recent, candidates), [0]);
});

test('selectGapFill admits anchored leading and trailing driving chains', () => {
  const recent = [ts('2026-06-01T10:00:00')];
  const candidates = [
    {
      timestampMs: ts('2026-06-01T09:58:10'),
      file: 'SavedClips/event/2026-06-01_09-58-10-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T09:59:10'),
      file: 'SavedClips/event/2026-06-01_09-59-10-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T10:01:01'),
      file: 'SavedClips/event/2026-06-01_10-01-01-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T10:02:02'),
      file: 'SavedClips/event/2026-06-01_10-02-02-front.mp4',
      driving: true,
    },
  ];

  assert.deepEqual(selectGapFill(recent, candidates), [0, 1, 2, 3]);
});

test('selectGapFill rejects parked candidates and isolated driving clusters', () => {
  const recent = [ts('2026-06-01T10:00:00')];
  const candidates = [
    {
      timestampMs: ts('2026-06-01T10:01:00'),
      file: 'SentryClips/event/2026-06-01_10-01-00-front.mp4',
      driving: false,
    },
    {
      timestampMs: ts('2026-06-01T14:00:00'),
      file: 'SavedClips/event/2026-06-01_14-00-00-front.mp4',
      driving: true,
    },
    {
      timestampMs: ts('2026-06-01T14:01:00'),
      file: 'SavedClips/event/2026-06-01_14-01-00-front.mp4',
      driving: true,
    },
  ];

  assert.deepEqual(selectGapFill(recent, candidates), []);
});
