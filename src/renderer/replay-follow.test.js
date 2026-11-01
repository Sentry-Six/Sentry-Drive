import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');

function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  assert.notEqual(i, -1, `function ${name} found in renderer.js`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  assert.fail(`unbalanced braces extracting ${name}`);
}

const code = [
  extractFn('replayPointLngLat'),
  extractFn('followReplayPoint'),
  extractFn('setReplayFollowing'),
].join('\n\n');

const interpolateReplayLngLat = new Function(
  `${extractFn('interpolateReplayLngLat')}; return interpolateReplayLngLat;`,
)();
const interpolateReplayZoom = new Function(
  `${extractFn('interpolateReplayZoom')}; return interpolateReplayZoom;`,
)();

function harness({ point = [37.5, -122.2] } = {}) {
  const centers = [];
  const classes = new Set();
  const attrs = new Map();
  const icon = { textContent: '' };
  const button = {
    title: '',
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name); else classes.delete(name);
      },
    },
    setAttribute(name, value) { attrs.set(name, value); },
    querySelector() { return icon; },
  };

  const api = new Function('mapArg', 'buttonArg', 'pointArg', `
    let replayFollowing = false;
    let mapReady = true;
    let map = mapArg;
    let replayDrive = { points: [pointArg] };
    let replayIdx = 0;
    let zoomStarts = 0;
    const cancelReplayFollowAnimation = () => null;
    const cancelReplayFollowZoom = () => {};
    const startReplayFollowZoom = () => { zoomStarts += 1; };
    const document = { getElementById: () => buttonArg };
    ${code}
    return {
      followReplayPoint,
      setReplayFollowing,
      isFollowing: () => replayFollowing,
      zoomStarts: () => zoomStarts,
    };
  `)({ setCenter: (center) => centers.push(center) }, button, point);

  return { ...api, attrs, button, centers, classes, icon };
}

test('enabling follow centers the map and exposes the active control state', () => {
  const h = harness();
  h.setReplayFollowing(true);

  assert.equal(h.isFollowing(), true);
  assert.deepEqual(h.centers, [[-122.2, 37.5]]);
  assert.equal(h.attrs.get('aria-pressed'), 'true');
  assert.equal(h.attrs.get('aria-label'), 'Stop following replay marker');
  assert.equal(h.button.title, 'Stop following replay marker');
  assert.equal(h.icon.textContent, 'location_on');
  assert.equal(h.classes.has('active'), true);
  assert.equal(h.zoomStarts(), 1);
});

test('disabling follow stops later replay points from moving the camera', () => {
  const h = harness();
  h.setReplayFollowing(true);
  h.setReplayFollowing(false);
  h.followReplayPoint([38, -123]);

  assert.deepEqual(h.centers, [[-122.2, 37.5]]);
  assert.equal(h.attrs.get('aria-pressed'), 'false');
  assert.equal(h.icon.textContent, 'my_location');
  assert.equal(h.classes.has('active'), false);
});

test('follow ignores missing and invalid coordinates', () => {
  const h = harness({ point: null });
  h.setReplayFollowing(true);
  h.followReplayPoint(['not-a-latitude', -122]);

  assert.deepEqual(h.centers, []);
});

test('camera interpolation advances smoothly between replay samples', () => {
  assert.deepEqual(interpolateReplayLngLat([-122, 37], [-121, 38], 0), [-122, 37]);
  assert.deepEqual(interpolateReplayLngLat([-122, 37], [-121, 38], 0.25), [-121.75, 37.25]);
  assert.deepEqual(interpolateReplayLngLat([-122, 37], [-121, 38], 1), [-121, 38]);
});

test('camera interpolation takes the short path across the dateline', () => {
  assert.deepEqual(interpolateReplayLngLat([179, 10], [-179, 12], 0.5), [180, 11]);
  assert.deepEqual(interpolateReplayLngLat([-179, 10], [179, 12], 0.5), [-180, 11]);
});

test('follow zoom eases into its street-level view', () => {
  assert.equal(interpolateReplayZoom(12, 17, 0), 12);
  assert.equal(interpolateReplayZoom(12, 17, 0.5), 16.375);
  assert.equal(interpolateReplayZoom(12, 17, 1), 17);
});
