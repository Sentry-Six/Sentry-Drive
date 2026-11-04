// Benchmark probe evaluated inside the Sentry Drive page. The same source runs
// in both builds: Electron receives it over the DevTools protocol, the Tauri
// build injects it from its bridge when SENTRY_DRIVE_BENCH_OUT is set.
//
// It only observes the page (performance entries, DOM, the renderer's own
// top-level `map`/`drives` bindings) and, in "drive" mode, re-runs the app's own
// autoLoadDriveData() once after the idle window to time a warm reload.
//
// window.__benchStart({ mode: 'drive' | 'idle', idleMs, file })
(function () {
  if (window.__benchStart) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (fn) => { try { return fn(); } catch { return false; } };
  async function waitFor(cond, timeoutMs = 600000) {
    const start = Date.now();
    while (!safe(cond)) {
      if (Date.now() - start > timeoutMs) throw new Error('bench wait timed out');
      await sleep(25);
    }
  }
  /* global map, mapReady, drives, autoLoadDriveData */
  const overlayHidden = () => document.getElementById('loading-overlay')?.classList.contains('hidden');
  const mapUsable = () => mapReady && map && map.loaded();
  const driveShown = () => overlayHidden()
    && drives.length > 0
    && document.querySelectorAll('.drive-item').length > 0
    && mapUsable();
  const mapIdle = () => mapUsable() && map.areTilesLoaded();

  // First contentful paint, if the engine reports it (read once, after the
  // page has certainly painted, so nothing polls during the idle window).
  function firstPaint() {
    const e = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
    return e ? performance.timeOrigin + e.startTime : null;
  }

  window.__benchStart = async function ({ mode, idleMs = 80000, file } = {}) {
    const R = window.__benchResults = { mode, timeOrigin: performance.timeOrigin, phase: 'started' };
    const report = (phase) => {
      R.phase = phase;
      try { window.__TAURI__?.core?.invoke('bench_report', { results: R }); } catch { /* electron */ }
    };
    try {
      if (mode === 'idle') {
        await waitFor(mapUsable);
        R.mapUsableAt = Date.now();
        await waitFor(mapIdle);
        R.mapIdleAt = Date.now();
        R.fcpAt = firstPaint();
        report('ready');
        return R;
      }
      await waitFor(driveShown);
      R.driveShownAt = Date.now();
      await waitFor(mapIdle);
      R.mapIdleAt = Date.now();
      R.driveCount = drives.length;
      R.fcpAt = firstPaint();
      report('shown');

      await sleep(idleMs);
      const start = Date.now();
      R.reloadStartAt = start;
      const pending = autoLoadDriveData(file);
      await sleep(50); // let the overlay appear before waiting on it
      await pending;
      await waitFor(driveShown);
      R.reloadMs = Date.now() - start;
      await waitFor(mapIdle);
      R.reloadIdleMs = Date.now() - start;
      report('reloaded');
    } catch (err) {
      R.error = String(err?.message ?? err);
      report('error');
    }
    return R;
  };
})();
