// Bridge between the renderer and the Rust backend.
//
// Injected as an initialization script before any page script runs. It
// installs `window.electronAPI` (the name dates from the Electron build and is
// kept so the renderer is unchanged). Every method maps to a Rust command
// (src-tauri/src/*), and every on… subscription to a Tauri event of the same
// name.
(function () {
  'use strict';
  if (window.electronAPI) return;
  // Resolved lazily: the global API is installed by Tauri's own init scripts.
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

  // ipcRenderer.on-style subscription returning a synchronous unsubscribe.
  const on = (event) => (cb) => {
    let unlisten = null;
    let cancelled = false;
    window.__TAURI__.event.listen(event, (e) => cb(e.payload)).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) { unlisten(); unlisten = null; }
    };
  };

  window.electronAPI = {
    appLog: (entry) => { invoke('app_log', { entry: entry ?? {} }).catch(() => {}); },
    downloadLogs: () => invoke('download_logs'),
    selectDirectory: (options) => invoke('select_directory', { options: options ?? null }),
    selectFile: (options) => invoke('select_file', { options: options ?? null }),
    findDriveData: (dir) => invoke('find_drive_data', { dir }),
    getDefaultOutputDir: () => invoke('get_default_output_dir'),
    checkDriveData: (dir) => invoke('check_drive_data', { dir }),
    getCpuCount: () => invoke('get_cpu_count'),
    loadAndGroupDrives: (filePath) => invoke('load_and_group_drives', { filePath }),
    listDriveSummaries: (query) => invoke('list_drive_summaries', { query: query ?? null }),
    getDriveDetail: (driveId, gen) => invoke('get_drive_detail', { arg: { driveId, gen: gen ?? null } }),
    listChargingSites: (args) => invoke('list_charging_sites', { args: args ?? null }),
    listChargingSessions: (args) => invoke('list_charging_sessions', { args: args ?? null }),
    getChargingSession: (args) => invoke('get_charging_session', { args: args ?? null }),
    getSuperchargerCatalogStatus: () => invoke('get_supercharger_catalog_status'),
    refreshSuperchargerCatalog: () => invoke('refresh_supercharger_catalog'),
    onLoadProgress: on('load-progress'),

    // Check Drives (OSRM repair / Summon backfill) — not ported yet.
    repairGPS: (args) => invoke('repair_gps', { args }),
    checkSummon: (args) => invoke('check_summon', { args }),
    checkOnline: () => invoke('check_online'),
    revertGPS: (filePath) => invoke('revert_gps', { filePath }),
    hasGPSBackup: (filePath) => invoke('has_gps_backup', { filePath }),
    onRepairProgress: on('repair-progress'),

    setDriveTags: (args) => invoke('set_drive_tags', { args }),
    openExternal: (url) => invoke('open_external', { url }),
    reverseGeocode: (args) => invoke('reverse_geocode', { args: args ?? null }),
    getGeocodeSettings: () => invoke('get_geocode_settings'),
    setGeocodeSettings: (settings) => invoke('set_geocode_settings', { settings: settings ?? null }),
    rememberKnownPlace: (place) => invoke('remember_known_place', { place: place ?? null }),
    removeKnownPlace: (place) => invoke('remove_known_place', { place: place ?? null }),
    syncKnownPlaceZones: (args) => invoke('sync_known_place_zones', { args: args ?? null }),
    getAppVersion: () => invoke('get_app_version'),
    setAllowPrerelease: (allow) => invoke('set_allow_prerelease', { allow: !!allow }),
    revertToStable: () => invoke('revert_to_stable'),
    removeDrive: (args) => invoke('remove_drive', { args }),
    removeDrives: (args) => invoke('remove_drives', { args }),
    checkForUpdate: () => invoke('check_for_update'),
    downloadUpdate: () => invoke('download_update'),
    installUpdate: () => invoke('install_update'),
    getChangelog: () => invoke('get_changelog'),
    fetchRemoteChangelog: () => invoke('fetch_remote_changelog'),
    onUpdateStatus: on('update-status'),

    startProcessing: (args) => invoke('start_processing', { args }),
    stopProcessing: () => invoke('stop_processing'),
    onProcessingOutput: on('processing-output'),

    importDriveDataFilePreview: (args) => invoke('import_drive_data_file_preview', { args }),
    importDriveDataFile: (args) => invoke('import_drive_data_file', { args }),
    onImportJsonProgress: on('import-json-progress'),
    watchDriveData: (filePath) => invoke('watch_drive_data', { filePath: filePath ?? null }),
    onDriveDataChanged: on('drive-data-changed'),

    // Tessie / Teslascope imports.
    tessiePreview: (args) => invoke('tessie_preview', { args: args ?? null }),
    tessieImport: (args) => invoke('tessie_import', { args: args ?? null }),
    tessieImportCancel: () => invoke('tessie_import_cancel'),
    tessieRemoveAll: (args) => invoke('tessie_remove_all', { args: args ?? null }),
    tessieRemoveHidden: (args) => invoke('tessie_remove_hidden', { args: args ?? null }),
    tessieApiGetToken: () => invoke('tessie_api_get_token'),
    tessieApiSaveToken: (args) => invoke('tessie_api_save_token', { args }),
    tessieApiValidate: (args) => invoke('tessie_api_validate', { args: args ?? null }),
    tessieApiPreview: (args) => invoke('tessie_api_preview', { args: args ?? null }),
    tessieApiImport: (args) => invoke('tessie_api_import', { args: args ?? null }),
    tessieApiCancel: () => invoke('tessie_api_cancel'),
    onTessieProgress: on('tessie-progress'),
    teslascopeApiGetToken: () => invoke('teslascope_api_get_token'),
    teslascopeApiSaveToken: (args) => invoke('teslascope_api_save_token', { args }),
    teslascopeApiValidate: (args) => invoke('teslascope_api_validate', { args: args ?? null }),
    teslascopeApiPreview: (args) => invoke('teslascope_api_preview', { args: args ?? null }),
    teslascopeApiImport: (args) => invoke('teslascope_api_import', { args: args ?? null }),
    teslascopeApiCancel: () => invoke('teslascope_api_cancel'),
    teslascopeRemoveAll: (args) => invoke('teslascope_remove_all', { args: args ?? null }),
    teslascopeRemoveHidden: (args) => invoke('teslascope_remove_hidden', { args: args ?? null }),
    onTeslascopeProgress: on('teslascope-progress'),
  };

  // Keyboard shortcuts: DevTools and reload.
  window.addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    if (key === 'f12' || (e.ctrlKey && e.shiftKey && key === 'i')) {
      e.preventDefault();
      invoke('toggle_devtools').catch(() => {});
    } else if ((e.ctrlKey || e.metaKey) && key === 'r') {
      e.preventDefault();
      location.reload();
    }
  }, true);
})();
