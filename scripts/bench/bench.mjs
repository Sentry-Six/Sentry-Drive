#!/usr/bin/env node
// Before/after benchmark driver for the Electron and Tauri builds of Sentry Drive.
//
//   node scripts/bench/bench.mjs --app electron --bundle "dist/mac-universal/Sentry Drive.app" \
//        --file /path/drive-data.json --work /tmp/bench --runs 5 --idle-runs 3 --out electron.json
//   node scripts/bench/bench.mjs --app tauri --bundle "src-tauri/target/.../Sentry Drive.app" ...
//
// Each run launches the app binary directly (app fully quit between runs) and
// measures, on the same clock:
//   fcp          launch -> first contentful paint in the window
//   uiReady      launch -> renderer's own "ui ready" log line
//   driveShown   launch -> drive list rendered, loading overlay gone, map usable
//   mapIdle      launch -> as above and all visible map tiles loaded
//   memory       footprint of every attributed process, 15 s after driveShown
//   idle CPU     CPU time of every attributed process over the next 60 s
//   reload       warm in-app reload of the same file via autoLoadDriveData()
// "idle" runs start with auto-load off and measure memory/CPU with no drive.
//
// Electron is driven over the DevTools protocol on a throwaway --user-data-dir.
// The Tauri build runs the same probe from its bridge script when
// SENTRY_DRIVE_BENCH_OUT is set and writes results to that file.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = fs.readFileSync(path.join(HERE, 'probe.js'), 'utf8');
const CDP_PORT = 9333;
const SETTLE_MS = 15000;
const CPU_WINDOW_MS = 60000;
const IDLE_MS = 80000; // probe waits this long after the drive shows before the reload

function args() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  for (const k of ['app', 'bundle', 'file', 'work', 'out']) if (!o[k]) throw new Error(`--${k} required`);
  o.bundle = path.resolve(o.bundle);
  o.file = path.resolve(o.file);
  o.work = path.resolve(o.work);
  o.runs = Number(o.runs ?? 5);
  o['idle-runs'] = Number(o['idle-runs'] ?? 3);
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function procstat(pid) {
  return JSON.parse(execFileSync('python3', ['-I', path.join(HERE, 'procstat.py'), String(pid)], { encoding: 'utf8' }));
}

function binaryOf(bundle) {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const exe = execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist], { encoding: 'utf8' }).trim();
  return path.join(bundle, 'Contents', 'MacOS', exe);
}

// "[2026-11-04 06:18:33.725] [INFO ] [ui] ui ready ..." -> epoch ms (local time)
function logTime(line) {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
}

// Launch through LaunchServices (`open`), the way a user starts the app. This
// also makes the app its own "responsible process", so macOS attributes its
// helper and WebKit XPC processes to it (a child of this script would hand
// them to the terminal instead). stdout goes to a file we tail.
function launch(bundle, binary, argv, env, onLine, work) {
  const outFile = path.join(work, `stdout-${Date.now()}.log`);
  fs.writeFileSync(outFile, '');
  const openArgs = ['-n', '-F', '-a', bundle, '--stdout', outFile, '--stderr', outFile];
  for (const [k, v] of Object.entries(env)) openArgs.push('--env', `${k}=${v}`);
  if (argv.length) openArgs.push('--args', ...argv);
  const t0 = Date.now();
  execFileSync('open', openArgs);
  let pid = null;
  for (let i = 0; i < 400 && !pid; i++) {
    const ps = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && m[2].startsWith(binary)) pid = Number(m[1]);
    }
    if (!pid) execFileSync('sleep', ['0.025']);
  }
  if (!pid) throw new Error('app process not found after open');
  let offset = 0;
  let buf = '';
  const tail = setInterval(() => {
    let data;
    try {
      const fd = fs.openSync(outFile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size > offset) {
        const b = Buffer.alloc(size - offset);
        fs.readSync(fd, b, 0, b.length, offset);
        offset = size;
        data = b.toString('utf8');
      }
      fs.closeSync(fd);
    } catch { /* not yet */ }
    if (!data) return;
    buf += data;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }, 25);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const exited = new Promise((r) => { const iv = setInterval(() => { if (!alive()) { clearInterval(iv); clearInterval(tail); r(); } }, 100); });
  return { child: { pid, kill: (sig) => { try { process.kill(pid, sig); } catch { /* gone */ } } }, t0, exited };
}

async function quit(proc) {
  proc.child.kill('SIGTERM');
  const done = await Promise.race([proc.exited.then(() => true), sleep(15000).then(() => false)]);
  if (!done) { proc.child.kill('SIGKILL'); await proc.exited; }
  await sleep(3000); // let helper/XPC processes wind down before the next launch
}

// ── Minimal DevTools-protocol client (Electron only) ─────────────────────────
async function cdpConnect() {
  for (let i = 0; i < 400; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        };
        const send = (method, params = {}) => new Promise((res) => {
          const mid = ++id;
          pending.set(mid, res);
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
        const evaluate = async (expression, awaitPromise = false) => {
          const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
          if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
          return r.result?.result?.value;
        };
        return { ws, evaluate };
      }
    } catch { /* not up yet */ }
    await sleep(25);
  }
  throw new Error('DevTools endpoint never came up');
}

const waitPhaseExpr = (phases) => `new Promise((r) => { const iv = setInterval(() => {
  const R = window.__benchResults; if (R && ${JSON.stringify(phases)}.includes(R.phase)) { clearInterval(iv); r(JSON.stringify(R)); }
}, 25); })`;

// ── Driver per app ───────────────────────────────────────────────────────────
function electronDriver(o) {
  const binary = binaryOf(o.bundle);
  const profile = (variant) => path.join(o.work, `electron-profile-${variant}`);
  return {
    async seed(variant) {
      fs.rmSync(profile(variant), { recursive: true, force: true });
      const proc = launch(o.bundle, binary, [`--user-data-dir=${profile(variant)}`, `--remote-debugging-port=${CDP_PORT}`], {}, () => {}, o.work);
      const cdp = await cdpConnect();
      await sleep(3000);
      await cdp.evaluate(`localStorage.setItem('lastSeenVersion', ${JSON.stringify(o.version ?? '1.6.3')});
        localStorage.setItem('autoLoadDriveData', ${JSON.stringify(String(variant === 'drive'))});
        ${variant === 'drive' ? `localStorage.setItem('lastDriveDataPath', ${JSON.stringify(o.file)});` : `localStorage.removeItem('lastDriveDataPath');`}
        true`);
      await sleep(2000);
      cdp.ws.close();
      await quit(proc);
    },
    async start(variant, lines) {
      const proc = launch(o.bundle, binary, [`--user-data-dir=${profile(variant)}`, `--remote-debugging-port=${CDP_PORT}`], {}, (l) => lines.push({ at: Date.now(), l }), o.work);
      const cdp = await cdpConnect();
      await cdp.evaluate(PROBE);
      await cdp.evaluate(`window.__benchStart({ mode: ${JSON.stringify(variant)}, idleMs: ${IDLE_MS}, file: ${JSON.stringify(o.file)} }); true`);
      return {
        proc,
        waitPhase: async (phases) => JSON.parse(await cdp.evaluate(waitPhaseExpr(phases), true)),
        close: () => cdp.ws.close(),
      };
    },
  };
}

function tauriDriver(o) {
  const binary = binaryOf(o.bundle);
  const outFile = path.join(o.work, 'tauri-bench-results.json');
  return {
    async seed() { /* the Tauri bridge seeds localStorage itself in bench mode */ },
    async start(variant, lines) {
      fs.rmSync(outFile, { force: true });
      const proc = launch(o.bundle, binary, [], {
        SENTRY_DRIVE_BENCH_OUT: outFile,
        SENTRY_DRIVE_BENCH_MODE: variant,
        SENTRY_DRIVE_BENCH_FILE: o.file,
        SENTRY_DRIVE_BENCH_IDLE_MS: String(IDLE_MS),
      }, (l) => lines.push({ at: Date.now(), l }), o.work);
      return {
        proc,
        waitPhase: async (phases) => {
          for (;;) {
            try {
              const R = JSON.parse(fs.readFileSync(outFile, 'utf8'));
              if (phases.includes(R.phase)) return R;
            } catch { /* not written yet */ }
            await sleep(100);
          }
        },
        close: () => {},
      };
    },
  };
}

// Arrival time of the first matching stdout line (tailed every 25 ms). The
// logged wall-clock stamp is not used: Node's bundled time-zone data can
// disagree with the system's, which the apps themselves follow.
function findLog(lines, re) {
  const hit = lines.find((x) => re.test(x.l));
  return hit ? hit.at : null;
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

async function main() {
  const o = args();
  fs.mkdirSync(o.work, { recursive: true });
  const driver = o.app === 'electron' ? electronDriver(o) : tauriDriver(o);
  const results = { app: o.app, bundle: o.bundle, file: o.file, startedAt: new Date().toISOString(), drive: [], idle: [] };
  const save = () => fs.writeFileSync(o.out, JSON.stringify(results, null, 2));

  for (const variant of ['drive', 'idle']) {
    const runs = variant === 'drive' ? o.runs : o['idle-runs'];
    if (!runs) continue;
    await driver.seed(variant);
    for (let i = 0; i < runs; i++) {
      const lines = [];
      const s = await driver.start(variant, lines);
      const t0 = s.proc.t0;
      const R = await s.waitPhase(variant === 'drive' ? ['shown', 'error'] : ['ready', 'error']);
      if (R.error) throw new Error(`run failed: ${R.error}`);
      const anchor = variant === 'drive' ? R.driveShownAt : R.mapIdleAt;
      await sleep(Math.max(0, anchor + SETTLE_MS - Date.now()));
      const mem = procstat(s.proc.child.pid);
      const cpu0 = procstat(s.proc.child.pid);
      const c0 = Date.now();
      await sleep(CPU_WINDOW_MS);
      const cpu1 = procstat(s.proc.child.pid);
      const cpuPct = ((cpu1.total.cpu_ns - cpu0.total.cpu_ns) / 1e6) / (Date.now() - c0) * 100;
      const run = {
        variant,
        fcpMs: R.fcpAt ? Math.round(R.fcpAt - t0) : null,
        uiReadyMs: (findLog(lines, /\] ui ready/) ?? NaN) - t0,
        memFootprintMB: mem.total.footprint / 1048576,
        memResidentMB: mem.total.resident / 1048576,
        processCount: mem.count,
        processes: mem.procs.map((p) => ({ name: p.name, footprintMB: +(p.footprint / 1048576).toFixed(1) })),
        idleCpuPct: cpuPct,
      };
      if (variant === 'drive') {
        Object.assign(run, {
          driveShownMs: R.driveShownAt - t0,
          mapIdleMs: R.mapIdleAt - t0,
          loadedLogMs: (findLog(lines, /\] loaded \d+ drive/) ?? NaN) - t0,
          driveCount: R.driveCount,
        });
        const R2 = await s.waitPhase(['reloaded', 'error']);
        if (R2.error) throw new Error(`reload failed: ${R2.error}`);
        const after = procstat(s.proc.child.pid);
        Object.assign(run, {
          reloadMs: R2.reloadMs,
          reloadIdleMs: R2.reloadIdleMs,
          peakFootprintSumMB: after.total.peak_footprint / 1048576,
          memAfterReloadMB: after.total.footprint / 1048576,
        });
      } else {
        run.mapIdleMs = R.mapIdleAt - t0;
      }
      s.close();
      await quit(s.proc);
      results[variant].push(run);
      save();
      console.log(`${o.app} ${variant} run ${i + 1}/${runs}:`, JSON.stringify({ ...run, processes: undefined }));
    }
  }

  const summarize = (rows, keys) => Object.fromEntries(keys.map((k) => [k, median(rows.map((r) => r[k]))]));
  results.median = {
    drive: summarize(results.drive, ['fcpMs', 'uiReadyMs', 'driveShownMs', 'mapIdleMs', 'loadedLogMs', 'memFootprintMB', 'memResidentMB', 'processCount', 'idleCpuPct', 'reloadMs', 'reloadIdleMs', 'peakFootprintSumMB']),
    idle: summarize(results.idle, ['fcpMs', 'uiReadyMs', 'mapIdleMs', 'memFootprintMB', 'memResidentMB', 'processCount', 'idleCpuPct']),
  };
  results.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify(results.median, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
