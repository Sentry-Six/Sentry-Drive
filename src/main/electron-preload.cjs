'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: (opts) => ipcRenderer.invoke('select-directory', opts),
  selectFile: (opts) => ipcRenderer.invoke('select-file', opts),
  findDriveData: (dir) => ipcRenderer.invoke('find-drive-data', dir),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  checkDriveData: (dir) => ipcRenderer.invoke('check-drive-data', dir),
  getCpuCount: () => ipcRenderer.invoke('get-cpu-count'),
  loadAndGroupDrives: (fp) => ipcRenderer.invoke('load-and-group-drives', fp),
  getDriveDetail: (driveId) => ipcRenderer.invoke('get-drive-detail', driveId),
  repairGPS: (args) => ipcRenderer.invoke('repair-gps', args),
  checkOnline: () => ipcRenderer.invoke('check-online'),
  revertGPS: (fp) => ipcRenderer.invoke('revert-gps', fp),
  hasGPSBackup: (fp) => ipcRenderer.invoke('has-gps-backup', fp),
  onRepairProgress: (cb) => {
    const listener = (_ev, data) => cb(data);
    ipcRenderer.on('repair-progress', listener);
    return () => ipcRenderer.off('repair-progress', listener);
  },
  getDriveTags: (fp) => ipcRenderer.invoke('get-drive-tags', fp),
  setDriveTags: (args) => ipcRenderer.invoke('set-drive-tags', args),
  getAllTagNames: (fp) => ipcRenderer.invoke('get-all-tag-names', fp),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setAllowPrerelease: (allow) => ipcRenderer.invoke('set-allow-prerelease', allow),
  revertToStable: () => ipcRenderer.invoke('revert-to-stable'),
  removeDrive: (args) => ipcRenderer.invoke('remove-drive', args),
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
});
