#!/usr/bin/env node
// Loader parity check: run the original JavaScript loader (the code the
// Electron build runs in its utility process) over a drive-data.json and write
// one NDJSON line per drive — the full summary plus a digest of its detail.
// The Rust port writes the same format (`cargo run --example loader_dump`),
// and `--compare a b` diffs the two with a tight float tolerance.
//
//   TZ=America/Denver node scripts/tauri/loader-parity.mjs dump <drive-data.json> <out.ndjson>
//   node scripts/tauri/loader-parity.mjs compare <js.ndjson> <rust.ndjson>
//
// Pin TZ: clip filenames are parsed in local time, and Node's bundled ICU
// time-zone data can lag the system's (it does for America/Edmonton in 2026).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export function digestDetail(detail) {
  const pts = detail.points ?? [];
  const sum = [0, 0, 0, 0];
  for (const p of pts) for (let i = 0; i < 4; i++) sum[i] += Number(p[i] ?? 0);
  const hist = (xs) => {
    if (!xs) return null;
    const h = {};
    for (const x of xs) h[x] = (h[x] ?? 0) + 1;
    return h;
  };
  return {
    n: pts.length,
    sum,
    first: pts[0] ?? null,
    last: pts[pts.length - 1] ?? null,
    fsd: hist(detail.fsdStates),
    gear: hist(detail.gearStates),
    events: (detail.fsdEvents ?? []).map((e) => `${e.type}@${e.lat.toFixed(6)},${e.lng.toFixed(6)}`),
  };
}

async function dump(file, outPath) {
  const { createLoaderService } = require(path.join(root, 'src/main/drive-loader-service.cjs'));
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-parity-'));
  const svc = createLoaderService({ cacheRoot });
  const t0 = Date.now();
  const res = await svc.load({ filePath: file, pageSize: 1000 });
  const out = fs.createWriteStream(outPath);
  const { drives: _d, page: _p, ...meta } = res;
  out.write(JSON.stringify({ meta }) + '\n');
  let offset = 0;
  for (;;) {
    const page = svc.index.listDriveSummaries({ offset, limit: 1000 });
    for (const s of page.drives) {
      const detail = svc.index.getDriveDetail(s.id, 200000);
      out.write(JSON.stringify({ summary: s, detail: digestDetail(detail) }) + '\n');
    }
    offset += page.drives.length;
    if (page.drives.length === 0 || offset >= page.total) break;
  }
  const sites = svc.index.listChargingSites();
  out.write(JSON.stringify({ chargingSites: sites }) + '\n');
  for (const site of sites) {
    out.write(JSON.stringify({ chargingSessions: site.siteId, sessions: svc.index.listChargingSessions(site.siteId) }) + '\n');
  }
  out.end();
  await new Promise((r) => out.on('finish', r));
  await svc.close();
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  console.error(`js loader: ${res.totalDriveCount} drives in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function close(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!close(a[k], b[k])) return false;
    return true;
  }
  return a === b;
}

function diffKeys(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (!close(a?.[k], b?.[k])) out.push(`${prefix}${k}: js=${JSON.stringify(a?.[k])?.slice(0, 120)} rust=${JSON.stringify(b?.[k])?.slice(0, 120)}`);
  }
  return out;
}

function compare(jsPath, rustPath) {
  const read = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const js = read(jsPath);
  const rs = read(rustPath);
  const problems = [];
  const metaJs = js.find((x) => x.meta)?.meta ?? {};
  const metaRs = rs.find((x) => x.meta)?.meta ?? {};
  problems.push(...diffKeys(metaJs, metaRs, 'meta.').filter((l) => !l.startsWith('meta.cacheGen')));
  const drivesJs = js.filter((x) => x.summary);
  const drivesRs = rs.filter((x) => x.summary);
  if (drivesJs.length !== drivesRs.length) problems.push(`drive count: js=${drivesJs.length} rust=${drivesRs.length}`);
  let identical = 0;
  for (let i = 0; i < Math.min(drivesJs.length, drivesRs.length); i++) {
    const a = drivesJs[i];
    const b = drivesRs[i];
    const d = [...diffKeys(a.summary, b.summary, 'summary.'), ...diffKeys(a.detail, b.detail, 'detail.')];
    if (d.length) problems.push(`drive #${i} (${a.summary.startTime}):\n    ${d.join('\n    ')}`);
    else identical++;
  }
  const sitesJs = js.find((x) => x.chargingSites)?.chargingSites ?? [];
  const sitesRs = rs.find((x) => x.chargingSites)?.chargingSites ?? [];
  if (!close(sitesJs, sitesRs)) problems.push(`charging sites differ (js ${sitesJs.length}, rust ${sitesRs.length})`);
  const sessJs = js.filter((x) => x.chargingSessions);
  const sessRs = rs.filter((x) => x.chargingSessions);
  if (!close(sessJs, sessRs)) problems.push('charging sessions differ');
  console.log(`${identical}/${drivesJs.length} drives identical (summary + detail digest), ${sitesJs.length} charging sites compared`);
  if (problems.length) {
    console.log(`${problems.length} difference(s):`);
    for (const p of problems.slice(0, 40)) console.log('  ' + p);
    process.exitCode = 1;
  } else {
    console.log('PARITY OK');
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'dump') await dump(path.resolve(a), path.resolve(b));
else if (cmd === 'compare') compare(a, b);
else {
  console.error('usage: loader-parity.mjs dump <drive-data.json> <out.ndjson> | compare <js.ndjson> <rust.ndjson>');
  process.exit(2);
}
