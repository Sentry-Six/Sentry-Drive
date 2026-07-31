import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const chargingUiSource = fs.readFileSync(new URL('./charging-ui.js', import.meta.url), 'utf8');

function loadChargingUi(Marker) {
  const context = vm.createContext({
    console,
    document: {
      createElement() {
        return { addEventListener() {} };
      },
    },
    map: { id: 'test-map' },
    maplibregl: { Marker },
  });
  vm.runInContext(chargingUiSource, context, { filename: 'charging-ui.js' });
  return context;
}

test('positions a charging cluster marker before attaching it to the map', () => {
  class LifecycleCheckingMarker {
    setLngLat(coordinates) {
      this.coordinates = coordinates;
      return this;
    }

    addTo(map) {
      if (!this.coordinates) throw new Error('Marker attached before it was positioned');
      this.map = map;
      return this;
    }
  }

  const context = loadChargingUi(LifecycleCheckingMarker);
  const entry = context.createChargingClusterMarker(17, [-77.04, 38.91]);

  assert.deepEqual(Array.from(entry.coordinates), [-77.04, 38.91]);
  assert.deepEqual(Array.from(entry.marker.coordinates), [-77.04, 38.91]);
  assert.equal(entry.marker.map, context.map);
});
