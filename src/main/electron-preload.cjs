'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const driveCalc = require('../shared/drive-calc.cjs');
const driveTelemetryView = require('../renderer/drive-telemetry-view.cjs');

contextBridge.exposeInMainWorld('electronAPI', {
  appLog: (entry) => ipcRenderer.send('app-log', entry),
  downloadLogs: () => ipcRenderer.invoke('download-logs'),
  selectDirectory: (opts) => ipcRenderer.invoke('select-directory', opts),
  selectFile: (opts) => ipcRenderer.invoke('select-file', opts),
  findDriveData: (dir) => ipcRenderer.invoke('find-drive-data', dir),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  checkDriveData: (dir) => ipcRenderer.invoke('check-drive-data', dir),
  getCpuCount: () => ipcRenderer.invoke('get-cpu-count'),
  loadAndGroupDrives: (fp) => ipcRenderer.invoke('load-and-group-drives', fp),
  listDriveSummaries: (query) => ipcRenderer.invoke('list-drive-summaries', query),
  getDriveDetail: (driveId, gen) => ipcRenderer.invoke('get-drive-detail', { driveId, gen }),
  listChargingSites: (args) => ipcRenderer.invoke('list-charging-sites', args),
  listChargingSessions: (args) => ipcRenderer.invoke('list-charging-sessions', args),
  getChargingSession: (args) => ipcRenderer.invoke('get-charging-session', args),
  getSuperchargerCatalogStatus: () => ipcRenderer.invoke('get-supercharger-catalog-status'),
  refreshSuperchargerCatalog: () => ipcRenderer.invoke('refresh-supercharger-catalog'),
  onLoadProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('load-progress', listener);
    return () => ipcRenderer.off('load-progress', listener);
  },
  repairGPS: (args) => ipcRenderer.invoke('repair-gps', args),
  checkSummon: (args) => ipcRenderer.invoke('check-summon', args),
  checkOnline: () => ipcRenderer.invoke('check-online'),
  revertGPS: (fp) => ipcRenderer.invoke('revert-gps', fp),
  hasGPSBackup: (fp) => ipcRenderer.invoke('has-gps-backup', fp),
  onRepairProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('repair-progress', listener);
    return () => ipcRenderer.off('repair-progress', listener);
  },
  setDriveTags: (args) => ipcRenderer.invoke('set-drive-tags', args),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  reverseGeocode: (args) => ipcRenderer.invoke('reverse-geocode', args),
  getGeocodeSettings: () => ipcRenderer.invoke('get-geocode-settings'),
  setGeocodeSettings: (args) => ipcRenderer.invoke('set-geocode-settings', args),
  rememberKnownPlace: (args) => ipcRenderer.invoke('remember-known-place', args),
  removeKnownPlace: (args) => ipcRenderer.invoke('remove-known-place', args),
  syncKnownPlaceZones: (args) => ipcRenderer.invoke('sync-known-place-zones', args),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setAllowPrerelease: (allow) => ipcRenderer.invoke('set-allow-prerelease', allow),
  revertToStable: () => ipcRenderer.invoke('revert-to-stable'),
  removeDrive: (args) => ipcRenderer.invoke('remove-drive', args),
  removeDrives: (args) => ipcRenderer.invoke('remove-drives', args),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getChangelog: () => ipcRenderer.invoke('get-changelog'),
  fetchRemoteChangelog: () => ipcRenderer.invoke('fetch-remote-changelog'),
  onUpdateStatus: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.off('update-status', listener);
  },
  startProcessing: (args) => ipcRenderer.invoke('start-processing', args),
  stopProcessing: () => ipcRenderer.invoke('stop-processing'),
  onProcessingOutput: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('processing-output', listener);
    return () => ipcRenderer.off('processing-output', listener);
  },
  importDriveDataFilePreview: (args) => ipcRenderer.invoke('import-drive-data-file-preview', args),
  importDriveDataFile: (args) => ipcRenderer.invoke('import-drive-data-file', args),
  onImportJsonProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('import-json-progress', listener);
    return () => ipcRenderer.off('import-json-progress', listener);
  },
  watchDriveData: (filePath) => ipcRenderer.invoke('watch-drive-data', filePath),
  onDriveDataChanged: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('drive-data-changed', listener);
    return () => ipcRenderer.off('drive-data-changed', listener);
  },
  tessiePreview: (args) => ipcRenderer.invoke('tessie-preview', args),
  tessieImport: (args) => ipcRenderer.invoke('tessie-import', args),
  tessieImportCancel: () => ipcRenderer.invoke('tessie-import-cancel'),
  tessieRemoveAll: (args) => ipcRenderer.invoke('tessie-remove-all', args),
  tessieRemoveHidden: (args) => ipcRenderer.invoke('tessie-remove-hidden', args),
  tessieApiGetToken: () => ipcRenderer.invoke('tessie-api-get-token'),
  tessieApiSaveToken: (args) => ipcRenderer.invoke('tessie-api-save-token', args),
  tessieApiValidate: (args) => ipcRenderer.invoke('tessie-api-validate', args),
  tessieApiPreview: (args) => ipcRenderer.invoke('tessie-api-preview', args),
  tessieApiImport: (args) => ipcRenderer.invoke('tessie-api-import', args),
  tessieApiCancel: () => ipcRenderer.invoke('tessie-api-cancel'),
  onTessieProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('tessie-progress', listener);
    return () => ipcRenderer.off('tessie-progress', listener);
  },
  // ── Teslascope import ──
  teslascopeApiGetToken: () => ipcRenderer.invoke('teslascope-api-get-token'),
  teslascopeApiSaveToken: (args) => ipcRenderer.invoke('teslascope-api-save-token', args),
  teslascopeApiValidate: (args) => ipcRenderer.invoke('teslascope-api-validate', args),
  teslascopeApiPreview: (args) => ipcRenderer.invoke('teslascope-api-preview', args),
  teslascopeApiImport: (args) => ipcRenderer.invoke('teslascope-api-import', args),
  teslascopeApiCancel: () => ipcRenderer.invoke('teslascope-api-cancel'),
  teslascopeRemoveAll: (args) => ipcRenderer.invoke('teslascope-remove-all', args),
  teslascopeRemoveHidden: (args) => ipcRenderer.invoke('teslascope-remove-hidden', args),
  onTeslascopeProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('teslascope-progress', listener);
    return () => ipcRenderer.off('teslascope-progress', listener);
  },
});

// Expose the calculation contract read-only to the sandboxed renderer.
contextBridge.exposeInMainWorld('driveCalc', { ...driveCalc });
contextBridge.exposeInMainWorld('driveTelemetryView', { ...driveTelemetryView });
