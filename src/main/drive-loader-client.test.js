import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDriveLoaderClient } from './drive-loader-client.cjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.killed = false;
  }

  postMessage(message) {
    this.sent.push(message);
  }

  kill() {
    this.killed = true;
    return true;
  }
}

test('client correlates responses and forwards progress for the active load', async () => {
  const child = new FakeChild();
  const client = createDriveLoaderClient({
    fork: () => child,
    workerPath: 'worker.cjs',
    cacheRoot: 'cache',
  });
  const progress = [];
  const pending = client.load('drive-data.json', (value) => progress.push(value));
  const request = child.sent[0];

  child.emit('message', { type: 'progress', payload: { phase: 'reading', current: 1, total: 2 } });
  child.emit('message', { id: request.id, ok: true, result: { success: true, totalDriveCount: 3 } });

  assert.deepEqual(await pending, { success: true, totalDriveCount: 3 });
  assert.deepEqual(progress, [{ phase: 'reading', current: 1, total: 2 }]);
  await client.close();
  assert.equal(child.killed, true);
});

test('client rejects every pending request when the utility process exits', async () => {
  const child = new FakeChild();
  const client = createDriveLoaderClient({
    fork: () => child,
    workerPath: 'worker.cjs',
    cacheRoot: 'cache',
  });
  const first = client.list({ offset: 0, limit: 25 });
  const second = client.detail(1);

  child.emit('exit', 9);

  await assert.rejects(first, (error) => error.code === 'DRIVE_LOADER_EXITED');
  await assert.rejects(second, (error) => error.code === 'DRIVE_LOADER_EXITED');
});
