// In-window UI test for the Tauri build. Injected by test builds only
// (SENTRY_DRIVE_TEST_HOOKS at build time + SENTRY_DRIVE_UI_TEST at run time);
// each step reports a line through `ui_test_report`. It clicks the real
// controls, stubbing only the native file pickers. Configuration comes from
// window.__UI_TEST__ (set by the line the runner prepends to this file).
(function () {
  const C = window.__UI_TEST__ || {};
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const report = (line) => invoke('ui_test_report', { line }).catch(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const shown = (el) => !!el && !el.classList.contains('hidden');
  async function waitFor(fn, ms, what) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = await fn(); } catch { v = false; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
      await sleep(150);
    }
  }
  const keyEnter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // Native file pickers are the one thing a script can't drive.
  const pick = (path) => { window.electronAPI.selectFile = async () => path; window.electronAPI.selectDirectory = async () => path; };
  const driveCount = () => document.querySelectorAll('#drives-list .drive-item').length;
  const checkResult = async (what) => {
    await waitFor(() => shown($('check-result-overlay')), 600000, what);
    const msg = $('check-result-title').textContent + ' | ' + $('check-result-msg').textContent;
    $('btn-check-result-ok').click();
    return msg;
  };

  // Native message boxes would stall an unattended run: record what the app
  // says instead (the real dialogs are checked separately).
  const dialogs = [];
  window.alert = (m) => { dialogs.push(String(m)); };
  window.confirm = async (m) => { dialogs.push('confirm: ' + String(m)); return true; };
  const lastDialog = () => dialogs[dialogs.length - 1] || '';

  const steps = [];
  const step = (name, fn) => steps.push({ name, fn });

  step('startup: drives auto-loaded from the migrated lastDriveDataPath', async () => {
    await waitFor(() => driveCount() > 0, 120000, 'drive list');
    if (shown($('update-overlay'))) $('btn-update-skip').click();
    return { loadedFilePath, drives: drives.length, items: driveCount(), version: await window.electronAPI.getAppVersion() };
  });

  step('migration: renderer settings came across from Electron', async () => {
    const zones = JSON.parse(localStorage.getItem('privacyZones') || '[]');
    const got = {
      unitSystem: localStorage.getItem('unitSystem'),
      zones: zones.map((z) => z.name),
      unicodeKey: localStorage.getItem('café-\u{1F697}'),
      markerColor: localStorage.getItem('markerColor'),
      imported: localStorage.getItem('__importedFromElectron') !== null,
      unitToggle: document.querySelector('#unit-toggle .active')?.textContent?.trim(),
    };
    if (got.unitSystem !== 'metric' || !got.zones.includes('Home') || got.unicodeKey !== 'unicode ✓') throw new Error(JSON.stringify(got));
    return got;
  });

  step('migration: tokens readable from the Keychain', async () => {
    const a = await window.electronAPI.tessieApiGetToken();
    const b = await window.electronAPI.teslascopeApiGetToken();
    $('btn-settings').click();
    document.querySelector('[data-stab="integrations"], #stab-integrations')?.click?.();
    await sleep(500);
    const ui = { tessieConnected: shown($('tessie-connected')), mask: $('tessie-token-mask')?.textContent, teslascopeConnected: shown($('teslascope-connected')) };
    $('btn-close-settings').click();
    if (a.token !== 'fake-tessie-token-123' || b.token !== 'fake-teslascope-token-456') throw new Error('tokens ' + JSON.stringify([a.token.length, b.token.length]));
    return ui;
  });

  step('integrations: validating a bad token shows the service error', async () => {
    const r = await window.electronAPI.tessieApiValidate({ token: 'fake-tessie-token-123' });
    const s = await window.electronAPI.teslascopeApiValidate({ token: 'fake-teslascope-token-456' });
    if (r.success || s.success) throw new Error('fake tokens validated?');
    return { tessie: r.error, teslascope: s.error };
  });

  step('integrations: token save, replace and clear round-trip', async () => {
    await window.electronAPI.tessieApiSaveToken({ token: 'second-token' });
    const a = (await window.electronAPI.tessieApiGetToken()).token;
    await window.electronAPI.tessieApiSaveToken({ token: '' });
    const b = (await window.electronAPI.tessieApiGetToken()).token;
    await window.electronAPI.tessieApiSaveToken({ token: 'fake-tessie-token-123' });
    if (a !== 'second-token' || b !== '') throw new Error(JSON.stringify([a, b]));
    return { replaced: a, cleared: b === '' };
  });

  step('processing tab: process a clips folder', async () => {
    switchMainTab('processing');
    $('clips-dir').value = C.clips;
    $('output-path').value = C.out;
    $('btn-process-new').click();
    await waitFor(() => $('btn-process-new').disabled, 10000, 'processing start');
    await waitFor(() => !$('btn-process-new').disabled, 900000, 'processing end');
    const log = $('log-output').innerText;
    if (!/Processing complete/.test(log)) throw new Error(log.slice(-800));
    return { phase: $('progress-phase').textContent, tail: log.trim().split('\n').slice(-6) };
  });

  step('load the processed drive-data.json', async () => {
    switchMainTab('drives');
    await autoLoadDriveData(C.out + '/drive-data.json');
    await waitFor(() => driveCount() > 0 && loadedFilePath === C.out + '/drive-data.json', 60000, 'processed drives');
    return { drives: drives.length, first: drives[0] && { start: drives[0].startTime, mi: drives[0].distanceMi } };
  });

  step('drive detail: select a drive, map + stats', async () => {
    const item = document.querySelector('#drives-list .drive-item');
    item.click();
    await waitFor(() => selectedDriveId !== null && shown($('map-stats')), 30000, 'selection');
    await waitFor(() => shown($('replay-bar')), 30000, 'replay bar');
    return { selectedDriveId, stats: $('map-stats').innerText.split('\n').slice(0, 8) };
  });

  step('replay: play advances the slider, pause stops it', async () => {
    const s = $('replay-slider');
    const before = Number(s.value);
    $('btn-replay-play').click();
    await waitFor(() => Number(s.value) > before + 2, 15000, 'replay advance');
    $('btn-replay-play').click();
    const paused = Number(s.value);
    await sleep(800);
    if (Number(s.value) !== paused) throw new Error('still moving after pause');
    $('replay-slider').value = String(Math.floor(Number(s.max) / 2));
    $('replay-slider').dispatchEvent(new Event('input', { bubbles: true }));
    return { before, paused, max: Number(s.max), time: $('replay-time-current').textContent, gear: $('replay-gear-val')?.textContent };
  });

  step('tags: add a tag in the detail panel; it is written to drive-data.json', async () => {
    const panel = $('map-stats');
    panel.querySelector('#btn-add-tag').click();
    const input = panel.querySelector('#tag-input');
    input.value = 'e2e-tag';
    keyEnter(input);
    await waitFor(() => document.querySelector('.tag-pill[data-tag="e2e-tag"]'), 10000, 'tag pill');
    const drive = drives.find((d) => d.id === selectedDriveId);
    // Reload from disk: the tag must survive.
    const start = drive.startTime;
    await autoLoadDriveData(loadedFilePath);
    await waitFor(() => drives.some((d) => d.startTime === start && (d.tags || []).includes('e2e-tag')), 30000, 'tag after reload');
    return { start, filterHasTag: $('tag-filter').innerText.includes('e2e-tag') };
  });

  step('tags: remove the tag', async () => {
    const d = drives.find((x) => (x.tags || []).includes('e2e-tag'));
    const item = [...document.querySelectorAll('#drives-list .drive-item')].find((el) => el.querySelector('.tag-pill[data-tag="e2e-tag"]'));
    item.querySelector('.tag-pill[data-tag="e2e-tag"] .tag-remove, .tag-pill[data-tag="e2e-tag"] button').click();
    await waitFor(() => !document.querySelector('#drives-list .tag-pill[data-tag="e2e-tag"]'), 10000, 'tag gone');
    await sleep(500);
    await autoLoadDriveData(loadedFilePath);
    await waitFor(() => driveCount() > 0, 30000, 'reload');
    const again = drives.find((x) => x.startTime === d.startTime);
    if ((again.tags || []).includes('e2e-tag')) throw new Error('tag still on disk');
    return { start: d.startTime };
  });

  step('check drives: bridge gaps (online, road routing), then revert', async () => {
    $('btn-repair-gps').click();
    await waitFor(() => shown($('check-drives-overlay')), 5000, 'check overlay');
    $('btn-check-bridge').click();
    const msg = await checkResult('bridge result');
    await waitFor(() => shown($('btn-revert-gps')), 10000, 'revert button');
    await waitFor(() => driveCount() > 0, 60000, 'reload after bridge');
    const bridged = drives.filter((d) => d.bridged).length;
    $('btn-revert-gps').click();
    await waitFor(() => shown($('revert-overlay')), 5000, 'revert overlay');
    $('btn-revert-confirm').click();
    await sleep(1500);
    await waitFor(() => driveCount() > 0, 60000, 'reload after revert');
    return { msg, bridgedDrives: bridged, afterRevertBridged: drives.filter((d) => d.bridged).length };
  });

  step('check drives: check for Summon (re-reads clips)', async () => {
    $('btn-repair-gps').click();
    await waitFor(() => shown($('check-drives-overlay')), 5000, 'check overlay');
    $('btn-check-summon').click();
    return { msg: await checkResult('summon result') };
  });

  step('import: Tessie CSV export (preview + import)', async () => {
    const before = drives.length;
    $('btn-import-tessie').click();
    await waitFor(() => shown($('tessie-overlay')), 5000, 'import overlay');
    document.querySelector('.tessie-mode-btn[data-mode="csv"]').click();
    pick(C.fixtures + '/drives.csv'); $('browse-tessie-drives').click(); await sleep(200);
    pick(C.fixtures + '/driving_states.csv'); $('browse-tessie-states').click(); await sleep(200);
    $('btn-tessie-confirm').click();
    await waitFor(() => $('btn-tessie-confirm').textContent === 'Importing…', 30000, 'import start');
    const preview = $('tessie-preview').innerText;
    // On success the app closes the dialog and shows a summary.
    await waitFor(() => !shown($('tessie-overlay')), 120000, 'import end');
    const summary = lastDialog();
    await waitFor(() => drives.length > before, 60000, 'drives after import');
    return { preview: preview.slice(0, 300), summary: summary.slice(0, 300), before, after: drives.length, tessieDrives: drives.filter((d) => d.source === 'tessie').length };
  });

  step('import: another drive-data.json (merge)', async () => {
    const before = drives.length;
    $('btn-import-tessie').click();
    await waitFor(() => shown($('tessie-overlay')), 5000, 'import overlay');
    document.querySelector('.tessie-mode-btn[data-mode="json"]').click();
    pick(C.fixtures + '/drive-data.json'); $('browse-import-json').click(); await sleep(200);
    $('btn-tessie-confirm').click();
    await waitFor(() => shown($('import-json-confirm-overlay')), 30000, 'merge confirm');
    $('btn-import-json-confirm').click();
    await waitFor(() => drives.length > before, 120000, 'drives after merge');
    if (shown($('tessie-overlay'))) $('btn-tessie-cancel').click();
    return { before, after: drives.length };
  });

  step('remove imported: Tessie drives', async () => {
    const before = drives.filter((d) => d.source === 'tessie').length;
    $('btn-remove-tessie').click();
    await waitFor(() => shown($('remove-tessie-overlay')), 5000, 'remove overlay');
    $('remove-src-tessie').checked = true; $('remove-src-tessie').dispatchEvent(new Event('change'));
    $('remove-src-teslascope').checked = false; $('remove-src-teslascope').dispatchEvent(new Event('change'));
    const n = dialogs.length;
    $('btn-remove-tessie-confirm').click();
    await waitFor(() => dialogs.length > n, 60000, 'removal summary');
    await waitFor(() => !shown($('loading-overlay')), 60000, 'reload');
    // Nothing Tessie-sourced may be left in the file.
    const again = await window.electronAPI.tessieRemoveAll({ driveDataPath: loadedFilePath });
    if (again.removed !== 0) throw new Error('left in file: ' + JSON.stringify(again));
    await autoLoadDriveData(loadedFilePath);
    await waitFor(() => driveCount() > 0, 30000, 'reload');
    return { before, after: drives.filter((d) => d.source === 'tessie').length, summary: lastDialog() };
  });

  step('remove drive: one drive from the list', async () => {
    const before = drives.length;
    const item = document.querySelectorAll('#drives-list .drive-item');
    const target = item[item.length - 1];
    target.querySelector('.drive-remove-btn').click();
    await waitFor(() => shown($('remove-drive-overlay')), 5000, 'remove overlay');
    $('btn-remove-drive-confirm').click();
    await waitFor(() => drives.length === before - 1, 60000, 'one fewer');
    await autoLoadDriveData(loadedFilePath);
    await waitFor(() => drives.length === before - 1, 60000, 'still fewer after reload');
    return { before, after: drives.length };
  });

  step('remove drives: multi-select', async () => {
    const before = drives.length;
    const ids = drives.slice(0, 2).map((d) => String(d.id));
    ids.forEach((id) => toggleMultiSelect(id));
    await waitFor(() => shown($('multi-select-bar')), 5000, 'multi bar');
    $('btn-multi-remove').click();
    await waitFor(() => shown($('remove-drives-overlay')), 5000, 'confirm');
    $('btn-remove-drives-confirm').click();
    await waitFor(() => drives.length === before - 2, 60000, 'two fewer');
    return { before, after: drives.length };
  });

  step('settings: switch units and persist', async () => {
    const btn = document.querySelector('#unit-toggle [data-unit="imperial"], #unit-toggle button:not(.active)');
    btn?.click();
    await sleep(300);
    return { unitSystem: localStorage.getItem('unitSystem') };
  });

  step('update: check, download and install v' + (C.expectUpdate || '?'), async () => {
    const seen = [];
    window.electronAPI.onUpdateStatus((s) => seen.push(s));
    await window.electronAPI.checkForUpdate();
    await waitFor(() => seen.some((s) => s.status === 'available' || s.status === 'error' || s.status === 'up-to-date'), 30000, 'check');
    if (!seen.some((s) => s.status === 'available')) throw new Error(JSON.stringify(seen));
    await window.electronAPI.downloadUpdate();
    await waitFor(() => seen.some((s) => s.status === 'ready' || s.status === 'error'), 120000, 'download');
    await report({ step: 'update: statuses before install', ok: true, detail: seen.map((s) => s.status + (s.version ? ' ' + s.version : '') + (s.percent != null ? ' ' + s.percent + '%' : '')) });
    if (!seen.some((s) => s.status === 'ready')) throw new Error(JSON.stringify(seen));
    await report({ step: 'done', ok: true });
    window.electronAPI.installUpdate();
    return 'installing (the app restarts)';
  });

  async function run() {
    for (const s of steps) {
      if (C.only && !C.only.includes(steps.indexOf(s))) continue;
      const t0 = Date.now();
      try {
        const detail = await s.fn();
        await report({ step: s.name, ok: true, ms: Date.now() - t0, detail });
      } catch (e) {
        await report({ step: s.name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e) });
        for (const id of ['check-result-overlay', 'tessie-overlay', 'remove-drive-overlay', 'remove-drives-overlay', 'remove-tessie-overlay', 'import-json-confirm-overlay', 'update-overlay', 'settings-overlay']) {
          $(id)?.classList.add('hidden');
        }
      }
    }
    await report({ step: 'finished', ok: true });
  }
  window.addEventListener('load', () => setTimeout(run, 1500));
})();
