import test from 'node:test';
import assert from 'node:assert/strict';
import clipPath from './clip-path.cjs';

const { normalizeClipPath, isEventFolderPath, parseClipTimestampMs } = clipPath;

test('normalizeClipPath canonicalizes only a leading RecentClips component', () => {
  assert.equal(
    normalizeClipPath('RecentClips\\2026-07-27\\2026-07-27_14-01-02-front.mp4'),
    '2026-07-27/2026-07-27_14-01-02-front.mp4',
  );
  assert.equal(
    normalizeClipPath('2026-07-27/2026-07-27_14-01-02-front.mp4'),
    '2026-07-27/2026-07-27_14-01-02-front.mp4',
  );
  assert.equal(
    normalizeClipPath('SavedClips/2026-07-27_14-12-29/clip-front.mp4'),
    'SavedClips/2026-07-27_14-12-29/clip-front.mp4',
  );
  assert.equal(normalizeClipPath('MyRecentClips/clip-front.mp4'), 'MyRecentClips/clip-front.mp4');
  assert.equal(normalizeClipPath('RecentClips/'), 'RecentClips/');
});

test('clip timestamp parsing uses the final filename component', () => {
  assert.equal(
    parseClipTimestampMs(
      'SavedClips/2026-07-27_14-12-29/2026-07-27_14-02-02-front.mp4',
    ),
    new Date('2026-07-27T14:02:02').getTime(),
  );
  assert.equal(parseClipTimestampMs('SavedClips/no-time/front.mp4'), null);
});

test('event recognition survives canonical slash normalization', () => {
  assert.equal(isEventFolderPath('SavedClips\\event\\clip-front.mp4'), true);
  assert.equal(isEventFolderPath('SentryClips/event/clip-front.mp4'), true);
  assert.equal(isEventFolderPath('RecentClips/event/clip-front.mp4'), false);
});
