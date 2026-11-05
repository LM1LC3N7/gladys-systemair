// -----------------------------------------------------------------------------
// The integration on the real clock sped up 20 times, against a real TCP
// server on 127.0.0.1 (gladys-testkit) that answers Modbus like the fake
// unit and accepts one client at a time, with /data in a real temporary
// directory. The polling period is measured (start to start), the stop goes
// over a real socket, and the state file is the real one.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { SystemairApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { fileStore } from '../src/store.js';
import { defaultMap, frameAnswer } from './fixtures/fakeSystemair.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'systemair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('real clock x20: the period is the interval, start to start; the stop over a real socket', async (t) => {
  const regs = defaultMap();
  const device = await tcpServer({
    singleClient: true,
    latencyMs: 2,
    onData: (chunk) => frameAnswer(regs, chunk),
  });
  t.after(() => device.close());
  const dir = await tempDir(t);
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const config = { host: `127.0.0.1:${device.port}`, poll_interval: 30 };
  const gladys = createFakeGladys({ config });
  const app = new SystemairApp({
    gladys,
    logger: quiet,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store: fileStore(join(dir, 'state.json')),
  });
  t.after(() => app.stop({ shutdown: true }));
  registerHandlers(gladys, app, quiet);
  const spy = spyOn(app, 'run', clock);
  await app.boot();
  await gladys.connect();
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.equal(device.peak, 1, 'one connection at a time');
  assert.equal(device.refused, 0);
  // The stop, over the real socket.
  const ack = await gladys.fake.setValue(
    { external_id: 'ext:test-integration:systemair:unit' },
    { external_id: 'ext:test-integration:systemair:unit:stop' },
    1,
  );
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(regs.get(1131), 0);
  assert.equal(regs.get(1161), 1, 'manual mode, level off');
  assert.equal(regs.get(1351), 0, 'fans stopped');
  // The confirmation is written in the background (a stop never waits for /data).
  let kept;
  for (let i = 0; i < 50; i += 1) {
    kept = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    if (kept.stopGuard?.pending === false) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(kept.stopGuard.pending, false);
  assert.equal(kept.stopGuard.port, device.port);
  assert.equal(((await stat(join(dir, 'state.json'))).mode & 0o777).toString(8), '600');
});

test('fileStore: no file is null, an unreadable or corrupt file throws, a round trip', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ lastAttemptAt: 1 });
  assert.deepEqual(await store.load(), { lastAttemptAt: 1 });
  await writeFile(path, '{not json');
  await assert.rejects(store.load(), /not JSON/);
  await writeFile(path, 'x'.repeat(5000));
  await assert.rejects(store.load(), /too large/);
  await assert.rejects(fileStore(dir).load(), /unreadable/, 'a directory: unreadable, not empty');
  // A link is never followed.
  await writeFile(join(dir, 'real.json'), '{}');
  await symlink(join(dir, 'real.json'), join(dir, 'link.json'));
  await assert.rejects(fileStore(join(dir, 'link.json')).load(), /unreadable/);
});

test('fileStore: a FIFO is refused at once, never waited for, even with a writer; a name taken is an error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'systemair-'));
  const fifo = join(dir, 'state.json');
  execFileSync('mkfifo', [fifo]);
  // Whatever happens, the FIFO is woken up at the end (before the folder is
  // removed): a blocked open never holds the test.
  t.after(async () => {
    const wake = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    await wake.close();
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const started = Date.now();
  await assert.rejects(fileStore(fifo, { timeoutMs: 500 }).load(), /unreadable \(ENOTFILE\)/);
  assert.ok(
    Date.now() - started < 250,
    `refused at once (${Date.now() - started} ms), not by the bound`,
  );
  // A writer holding valid JSON in the FIFO: still not a regular file, refused.
  const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => writer.close().catch(() => {}));
  await writer.write('{"lastAttemptAt":1}');
  await assert.rejects(fileStore(fifo, { timeoutMs: 500 }).load(), /unreadable \(ENOTFILE\)/);
  // A temporary name already taken (here by a FIFO): O_EXCL refuses it, never a wait.
  const sub = join(dir, 'w');
  await mkdir(sub);
  const path = join(sub, 'state.json');
  const store = fileStore(path, { timeoutMs: 300 });
  execFileSync('mkfifo', [`${path}.1.tmp`]);
  await assert.rejects(store.save({ a: 1 }));
  await store.save({ a: 2 });
  assert.deepEqual(await store.load(), { a: 2 });
  assert.ok(
    (await readdir(sub)).every((name) => !name.startsWith('state.json.2')),
    'no leftover',
  );
});
