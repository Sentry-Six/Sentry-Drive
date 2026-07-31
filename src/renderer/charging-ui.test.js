import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const chargingUiSource = fs.readFileSync(new URL('./charging-ui.js', import.meta.url), 'utf8');

function loadChargingUi(map) {
  const context = vm.createContext({
    console,
    map,
  });
  vm.runInContext(chargingUiSource, context, { filename: 'charging-ui.js' });
  context.activeMainTab = 'charging';
  return context;
}

test('expands a rendered charging cluster at its map-source coordinate', async () => {
  let easeOptions = null;
  const map = {
    getSource() {
      return { getClusterExpansionZoom: async () => 8 };
    },
    easeTo(options) {
      easeOptions = options;
    },
  };
  const context = loadChargingUi(map);

  await context.expandChargingCluster(17, [-77.04, 38.91]);

  assert.deepEqual(Array.from(easeOptions.center), [-77.04, 38.91]);
  assert.equal(easeOptions.zoom, 8);
  assert.equal(easeOptions.duration, 450);
});
