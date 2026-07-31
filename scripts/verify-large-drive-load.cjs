'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLoaderService } = require('../src/main/drive-loader-service.cjs');
const {
  MUTABLE_SECTIONS,
  readTopLevelValues,
  scanTopLevelSections,
  writeDriveDataJSON,
} = require('../src/main/drive-data-writer.cjs');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const filePath = option('--file');
const rewriteCopy = process.argv.includes('--rewrite-copy');
if (!filePath) {
  console.error(
    'Usage: node scripts/verify-large-drive-load.cjs --file <drive-data.json> [--rewrite-copy]',
  );
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

async function hashSection(sourcePath, section) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(sourcePath, {
    start: section.start,
    end: section.end - 1,
  });
  for await (const chunk of stream) hash.update(chunk);
  return {
    bytes: section.end - section.start,
    sha256: hash.digest('hex'),
  };
}

async function hashSupplementalSections(sourcePath) {
  const sections = (await scanTopLevelSections(sourcePath))
    .filter((section) => !MUTABLE_SECTIONS.has(section.key));
  const hashes = {};
  for (const section of sections) hashes[section.key] = await hashSection(sourcePath, section);
  return hashes;
}

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
  const chargingSites = await service.handle({ type: 'charging-sites' });
  let chargingSample = null;
  for (const site of chargingSites) {
    const sessions = await service.handle({
      type: 'charging-sessions',
      payload: { siteId: site.siteId },
    });
    if (!sessions[0]) continue;
    const detail = await service.handle({
      type: 'charging-session',
      payload: { sessionId: sessions[0].sessionId },
    });
    chargingSample = {
      siteId: site.siteId,
      visitCount: site.visitCount,
      sessionId: sessions[0].sessionId,
      energyAddedKwh: detail.energyAddedKwh,
      peakPowerKw: detail.peakPowerKw,
      curveSampleCount: detail.chargeRateSamples?.length ?? 0,
      hasCost: detail.cost != null,
      costKeys: detail.cost && typeof detail.cost === 'object'
        ? Object.keys(detail.cost).sort()
        : [],
    };
    break;
  }
  let rewriteAcceptance = null;
  if (rewriteCopy) {
    const rewritePath = path.join(cacheRoot, 'drive-data-rewrite-copy.json');
    console.log(JSON.stringify({ type: 'progress', phase: 'rewrite-copy', percent: 0 }));
    fs.copyFileSync(filePath, rewritePath);
    const supplementalBefore = await hashSupplementalSections(rewritePath);
    const selected = await readTopLevelValues(rewritePath, ['driveTags']);
    const driveTags = selected.values.driveTags ?? {};
    driveTags.__chargingAcceptance__ = {
      verifiedAt: new Date().toISOString(),
    };
    await writeDriveDataJSON(rewritePath, { driveTags }, {
      sourceSections: selected.sections,
    });
    const supplementalAfter = await hashSupplementalSections(rewritePath);
    const supplementalPreserved = JSON.stringify(supplementalBefore)
      === JSON.stringify(supplementalAfter);
    if (!supplementalPreserved) {
      throw new Error('Supplemental sections changed during the rewrite-copy acceptance check');
    }
    const reloaded = await service.handle({
      type: 'load',
      payload: { filePath: rewritePath, pageSize: 1 },
    });
    rewriteAcceptance = {
      supplementalSections: Object.keys(supplementalBefore),
      supplementalPreserved,
      chargingSessionCount: reloaded.chargingSessionCount,
      chargingSiteCount: reloaded.chargingSiteCount,
      chargingCountsPreserved:
        reloaded.chargingSessionCount === result.chargingSessionCount
        && reloaded.chargingSiteCount === result.chargingSiteCount,
    };
    if (!rewriteAcceptance.chargingCountsPreserved) {
      throw new Error('Charging counts changed after the rewrite-copy reload');
    }
  }
  console.log(JSON.stringify({
    type: 'result',
    seconds: Math.round((Date.now() - started) / 1000),
    peakHeapMB: Math.round(peakHeap / 1024 / 1024),
    peakRssMB: Math.round(peakRss / 1024 / 1024),
    totalRoutes: result.totalRoutes,
    totalDriveCount: result.totalDriveCount,
    droppedCount: result.droppedCount,
    chargingSessionCount: result.chargingSessionCount,
    chargingSiteCount: result.chargingSiteCount,
    chargingSample,
    rewriteAcceptance,
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
