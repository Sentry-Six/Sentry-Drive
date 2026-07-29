'use strict';

const path = require('node:path');
const { createLoaderService } = require('./drive-loader-service.cjs');

const parentPort = process.parentPort;
if (!parentPort) throw new Error('drive-loader-worker must run as an Electron utility process');

const cacheRoot = path.resolve(process.argv[2]);
const service = createLoaderService({
  cacheRoot,
  send: (message) => parentPort.postMessage(message),
});

parentPort.on('message', async (event) => {
  const request = event.data;
  try {
    const result = await service.handle(request);
    parentPort.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: {
        code: error?.code ?? 'DRIVE_LOADER_FAILED',
        message: error?.message ?? String(error),
        stack: error?.stack,
      },
    });
  }
});

process.on('exit', () => {
  service.close().catch(() => {});
});
