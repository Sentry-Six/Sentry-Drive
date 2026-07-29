'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoaderService } = require('../src/main/drive-loader-service.cjs');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const filePath = option('--file');
if (!filePath) {
  console.error('Usage: node scripts/verify-large-drive-load.cjs --file <drive-data.json>');
  process.exit(2);
}

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-drive-verify-'));
let peakHeap = 0;
let peakRss = 0;
let lastProgress = '';
const started = Date.now();
const monitor = setInterval(() => {
  const memory = process.memoryUsage();
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
}, 250);

const service = createLoaderService({
  cacheRoot,
  send(message) {
    if (message.type !== 'progress') return;
    const { phase, current = 0, total = 0 } = message.payload;
    const percent = total > 0 ? Math.floor((current / total) * 100) : 0;
    const key = `${phase}:${percent}`;
    if (key === lastProgress || (percent % 5 !== 0 && current !== total)) return;
    lastProgress = key;
    console.log(JSON.stringify({ type: 'progress', phase, percent, current, total }));
  },
});

(async () => {
  const result = await service.handle({
    type: 'load',
    payload: { filePath, pageSize: 250 },
  });
  const middleOffset = Math.max(0, Math.floor(result.totalDriveCount / 2));
  const samples = [];
  for (const offset of [0, middleOffset, Math.max(0, result.totalDriveCount - 1)]) {
    const page = await service.handle({ type: 'list', payload: { offset, limit: 1 } });
    if (!page.drives[0]) continue;
    const detail = await service.handle({
      type: 'detail',
      payload: { id: page.drives[0].id, maxPoints: 10_000 },
    });
    samples.push({
      id: page.drives[0].id,
      startTime: page.drives[0].startTime,
      fullPointCount: detail.fullPointCount,
      displayPointCount: detail.displayPointCount,
    });
  }
  console.log(JSON.stringify({
    type: 'result',
    seconds: Math.round((Date.now() - started) / 1000),
    peakHeapMB: Math.round(peakHeap / 1024 / 1024),
    peakRssMB: Math.round(peakRss / 1024 / 1024),
    totalRoutes: result.totalRoutes,
    totalDriveCount: result.totalDriveCount,
    droppedCount: result.droppedCount,
    samples,
  }));
})().catch((error) => {
  console.error(JSON.stringify({
    type: 'error',
    code: error.code,
    message: error.message,
    stack: error.stack,
  }));
  process.exitCode = 1;
}).finally(async () => {
  clearInterval(monitor);
  await service.close();
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});
