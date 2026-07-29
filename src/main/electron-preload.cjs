'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const driveCalc = require('../shared/drive-calc.cjs');

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
  getDriveDetail: (driveId, gen) => ipcRenderer.invoke('get-drive-detail', { driveId, gen }),
  onLoadProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('load-progress', listener);
    return () => ipcRenderer.off('load-progress', listener);
  },
  repairGPS: (args) => ipcRenderer.invoke('repair-gps', args),
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
  // Import drives from another drive-data.json into the loaded one.
  importDriveDataFilePreview: (args) => ipcRenderer.invoke('import-drive-data-file-preview', args),
  importDriveDataFile: (args) => ipcRenderer.invoke('import-drive-data-file', args),
  onImportJsonProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('import-json-progress', listener);
    return () => ipcRenderer.off('import-json-progress', listener);
  },
  // Watch the loaded drive-data.json for external changes (e.g. Sentry USB
  // re-exporting it) and notify the renderer to auto-refresh.
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

// Drive-calc constants/helpers — the single source of truth shared with the
// processing pipeline. Exposed read-only so the renderer's display conversions
// use the exact same numbers as the rest of the app (src/shared/drive-calc.cjs).
contextBridge.exposeInMainWorld('driveCalc', { ...driveCalc });
