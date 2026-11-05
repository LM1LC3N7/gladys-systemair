// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Systemair SAVE
// unit, with the exact wiring of the container (src/handlers.js) and a mocked
// clock. The monotonic clock follows the mocked Date and moves 1 µs at every
// read (a decision that reads it twice sees it move).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SystemairApp } from '../src/app.js';
import { HOUR, MINUTE, MODES, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { deviceStates } from '../src/devices.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import {
  HOST,
  NOW,
  OTHER_SETTINGS,
  SETTINGS,
  UNIT_ID,
  fakeSystemair,
  setSettings,
  settle,
} from './fixtures/fakeSystemair.js';

const CFG = { host: HOST };
const ALLOW = { host: HOST, allow_commands: true };
const DEVICE = 'ext:test-integration:systemair:unit';
const UNIT = `${HOST}#${UNIT_ID}`;
const FINGERPRINT = SETTINGS.map((v) => v.toString(16).padStart(4, '0')).join('');
const feature = (role) => `${DEVICE}:${role}`;
const LEVEL_OFF = { fc: 6, register: 1131, value: 0 };
const MANUAL = { fc: 6, register: 1162, value: 2 };
const STOP = [LEVEL_OFF, MANUAL];
const START = { fc: 6, register: 1162, value: 1 };
const request = (value) => ({ fc: 6, register: 1162, value });
const level = (value) => ({ fc: 6, register: 1131, value });
const stops = (unit) => unit.writes().filter((w) => w.register === 1131 && w.value === 0).length;

/** A promise whose end is visible synchronously (`done`). */
function track(promise) {
  const tracked = promise.finally(() => {
    tracked.done = true;
  });
  tracked.done = false;
  return tracked;
}

/**
 * A getConfig() that answers the SDK's own resynchronization (the first call,
 * made by connect() before 'connected'), then fails `fails` times (Infinity:
 * always) in the integration's handler.
 */
function flakyConfig(fails, config = CFG) {
  let calls = 0;
  let left = fails;
  const fn = async () => {
    calls += 1;
    if (calls > 1 && left > 0) {
      left -= 1;
      throw new Error('Gladys busy');
    }
    return config;
  };
  fn.calls = () => calls;
  return fn;
}

async function setup(
  t,
  {
    config = CFG,
    unit = fakeSystemair(),
    store = memoryStore(),
    create = true,
    getConfig,
    boot = false,
    first = 1500,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  let drift = 0;
  const app = new SystemairApp({
    gladys,
    logger,
    connect: unit.connectFn,
    now: () => Date.now(),
    clock: () => Date.now() + (drift += 0.001),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(3);
    }
  };
  if (boot) {
    await app.boot();
    await settle();
  }
  t.after(() => app.stop({ shutdown: true }));
  const connecting = track(gladys.connect());
  await settle();
  await advance(first);
  // Never a wait without end, even under a mutant: 20 s more of mocked time at most.
  for (let i = 0; i < 200 && !connecting.done; i += 1) await advance(100, 50);
  assert.ok(connecting.done, 'connect() ended');
  await connecting;
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
    await advance(1100);
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = track(fire(role, value));
    await advance(wait, 50);
    // A test fails, never hangs: 10 s more of mocked time at most for the ack.
    for (let i = 0; i < 100 && !ack.done; i += 1) await advance(100, 50);
    assert.ok(ack.done, `${role} answered`);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const status = () => gladys.fake.connectionStatus;
  return { gladys, app, unit, advance, logs, fire, press, store, state, status };
}

/** Advances until the next poll is over (a dozen paced requests). */
const nextPoll = (ctx) => ctx.advance(MINUTE + 2 * SECOND, 100);

test('discovery: one device, every value read and published, the exact requests', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.model, 'Systemair SAVE');
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      (f.category === 'button' && f.type === 'push') ||
        (f.category === 'text' && f.type === 'select'),
      `${f.external_id} is writable`,
    );
  }
  const select = device.features.find((f) => f.external_id === feature('mode'));
  assert.deepEqual(
    select.supported_options.map((o) => o.value),
    MODES,
  );
  assert.ok(!MODES.includes('off') && !MODES.includes('stopped'), 'the stop is a button only');
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
  assert.equal(ctx.state('temperature-outdoor').state, -5.2, 'signed register');
  assert.equal(ctx.state('supply-setpoint').state, 18);
  assert.equal(ctx.state('humidity-extract').state, 41);
  assert.equal(ctx.state('fan-supply-level').state, 45);
  assert.equal(ctx.state('fan-extract-level').state, 47);
  assert.equal(ctx.state('filter-remaining').state, 120);
  assert.equal(ctx.state('power').state, 1);
  assert.equal(ctx.state('fans-running').state, 1);
  assert.equal(ctx.state('alarm-a').state, 0);
  assert.equal(ctx.state('alarm-b').state, 0);
  assert.equal(ctx.state('alarm-c').state, 0);
  assert.equal(ctx.state('manual-stop-allowed').state, 1);
  assert.equal(ctx.state('mode').text, 'auto');
  assert.equal(ctx.state('current-mode').text, 'auto');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.fr, /Systemair SAVE : auto/);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id ?? badge.external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // The registers of the list: input registers with function 4, holding with 3, unit id 1.
  assert.deepEqual(
    ctx.unit.log.slice(0, 12).map((r) => [r.fc, r.register, r.count, r.uid]),
    [
      [4, 1161, 1, 1],
      [3, 1131, 1, 1],
      [4, 1351, 1, 1],
      [3, 12101, 8, 1],
      [3, 12544, 1, 1],
      [3, 12136, 1, 1],
      [4, 14001, 3, 1],
      [3, 2001, 1, 1],
      [4, 15901, 3, 1],
      [4, 7005, 2, 1],
      [3, 1353, 1, 1],
      [3, 1401, 10, 1],
    ],
  );
  // Paced: never two requests in the same instant.
  const gaps = ctx.unit.log.slice(1, 12).map((r, i) => r.at - ctx.unit.log[i].at);
  assert.ok(
    gaps.every((g) => g >= 50),
    `gaps ${gaps}`,
  );
  assert.equal(ctx.unit.open.size, 0);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.deepEqual(ctx.store.data.identity, { unit: UNIT, fingerprint: FINGERPRINT });
});

test('SAVE Connect: every register with function 3, at most 2 a request, the same values', async (t) => {
  const unit = fakeSystemair({ saveConnect: true });
  const ctx = await setup(t, { unit, config: { ...ALLOW, gateway: 'save-connect' }, first: 5000 });
  assert.ok(
    ctx.unit.log.every((r) => r.fc !== 4),
    'never function 4',
  );
  assert.ok(ctx.unit.log.filter((r) => r.fc === 3).every((r) => r.count <= 2));
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('filter-remaining').state, 120);
  assert.equal(ctx.state('mode').text, 'auto');
  assert.deepEqual(ctx.store.data.identity, { unit: UNIT, fingerprint: FINGERPRINT });
  const ack = await ctx.press('mode', 'away');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [request(6)]);
  assert.equal((await ctx.press('stop')).success, true);
});

test('a generic gateway that refuses function 4: input registers read with function 3', async (t) => {
  const unit = fakeSystemair({ saveConnect: true });
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('mode').text, 'auto');
  assert.equal(ctx.state('fans-running').state, 1);
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /refuses function 4/);
  const fc4 = ctx.unit.log.filter((r) => r.fc === 4).length;
  assert.equal(fc4, 1, 'refused once, never asked again');
  await nextPoll(ctx);
  assert.equal(ctx.unit.log.filter((r) => r.fc === 4).length, 1);
});

test('alarms are binary sensors; a filter time of 0 is unknown, never "0 days"', async (t) => {
  const ctx = await setup(t);
  ctx.unit.regs.set(15901, 1);
  ctx.unit.regs.set(15903, 1);
  ctx.unit.regs.set(7005, 0);
  ctx.unit.regs.set(7006, 0);
  ctx.unit.regs.set(2001, 900);
  ctx.unit.regs.set(12103, 0x8000);
  const before = ctx.gladys.fake.states.length;
  await nextPoll(ctx);
  assert.equal(ctx.state('alarm-a').state, 1);
  assert.equal(ctx.state('alarm-b').state, 0);
  assert.equal(ctx.state('alarm-c').state, 1);
  assert.match(ctx.status().message.fr, /ALARME A/);
  const later = ctx.gladys.fake.states.slice(before);
  for (const role of ['filter-remaining', 'supply-setpoint', 'temperature-supply']) {
    assert.ok(
      !later.some((s) => s.device_feature_external_id === feature(role)),
      `${role} not published`,
    );
  }
});

test('the commands are off by default: mode and start refused, nothing written', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('mode', 'crowded');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser les commandes/);
  assert.equal((await ctx.press('start')).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a mode: decided on a fresh read, written in 1162, confirmed by the read back', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const reads = ctx.unit.reads();
  const ack = await ctx.press('mode', 'crowded');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [request(3)]);
  assert.ok(ctx.unit.reads() >= reads + 5, 'three fresh reads before, two reads back after');
  assert.equal(ctx.state('mode').text, 'crowded');
  assert.equal(ctx.state('current-mode').text, 'crowded');
  // Already so: nothing written, success.
  assert.equal((await ctx.press('mode', 'crowded')).success, true);
  assert.equal(ctx.unit.writes().length, 1);
});

test('a manual level: the level first, then the manual mode (only when not in manual yet)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const ack = await ctx.press('mode', 'manual-high');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [level(4), MANUAL]);
  assert.equal(ctx.state('mode').text, 'manual-high');
  assert.equal(ctx.state('current-mode').text, 'manual');
  assert.equal((await ctx.press('mode', 'manual-low')).success, true);
  assert.deepEqual(ctx.unit.writes(), [level(4), MANUAL, level(2)], 'already manual: level only');
  assert.equal(ctx.state('mode').text, 'manual-low');
});

test('the select takes only its values: never off, stopped, a read-only mode nor a number', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const bad of [
    'off',
    'stopped',
    'manual',
    'manual-off',
    'cooker-hood',
    'pressure-guard',
    0,
    3,
    '3',
    '',
    null,
    ' auto',
    'Auto',
    'toString',
    '__proto__',
    'constructor',
  ]) {
    assert.equal((await ctx.press('mode', bad, 100)).success, false, String(bad));
  }
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a stopped ventilation (manual, level off) is never started by a mode', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.halt();
  for (const choice of ['auto', 'manual-normal', 'away']) {
    const ack = await ctx.press('mode', choice);
    assert.equal(ack.success, false, choice);
    assert.match(String(ack.error), /ventilation est arrêtée/);
  }
  assert.deepEqual(ctx.unit.writes(), []);
  assert.equal(ctx.state('current-mode').text, 'stopped');
});

test('an unreadable state refuses the command (never decided on memory)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(1161, 99);
  const ack = await ctx.press('mode', 'away');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /relu/);
  ctx.unit.regs.set(1161, 1);
  ctx.unit.regs.set(1131, 1); // 1 is not a level of the list
  assert.match(String((await ctx.press('mode', 'away')).error), /relu/);
  ctx.unit.regs.set(1161, 0);
  ctx.unit.regs.set(1131, 3);
  ctx.unit.exceptions.add('4:1161');
  assert.equal((await ctx.press('mode', 'away')).success, false);
  ctx.unit.exceptions.clear();
  ctx.unit.exceptions.add('3:1401');
  const noId = await ctx.press('start');
  assert.match(String(noId.error), /relu/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('buttons only take 1; read-only features refuse', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const bad of [0, true, 'on', null, 2]) {
    assert.equal((await ctx.press('start', bad, 100)).success, false, String(bad));
    assert.equal((await ctx.press('stop', bad, 100)).success, false, String(bad));
  }
  assert.equal((await ctx.press('power', 0, 100)).success, false);
  assert.equal((await ctx.press('current-mode', 'auto', 100)).success, false);
  assert.equal((await ctx.press('fan-supply-level', 0, 100)).success, false);
  assert.equal((await ctx.press('temperature-outdoor', 1, 100)).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the start: 1162 = 1 (auto), confirmed; a write not applied is "not applied yet"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.halt();
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /pas encore appliquée/);
  assert.deepEqual(ctx.unit.writes(), [START]);
  ctx.unit.ignoreWrites = false;
  const again = await ctx.press('start');
  assert.equal(again.success, true, String(again.error));
  assert.equal(ctx.state('power').state, 1);
  assert.equal(ctx.state('mode').text, 'auto');
});

test('a write the unit refuses (exception 2): "refused", no guard; device failure: unconfirmed', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('6:1162');
  const ack = await ctx.press('mode', 'away');
  assert.match(String(ack.error), /a refusé la commande/);
  assert.equal(ctx.app.guards.size, 0);
  ctx.unit.exceptionCode = 4;
  const busy = await ctx.press('mode', 'away');
  assert.match(String(busy.error), /envoyée, sans confirmation/);
});

test('a manual level whose second write is refused: sent, without confirmation', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('6:1162');
  const ack = await ctx.press('mode', 'manual-high');
  assert.match(String(ack.error), /sans confirmation/);
  assert.deepEqual(ctx.unit.writes(), [level(4), MANUAL]);
  assert.ok(ctx.app.guards.has('modeChoice'));
});

test('a wrong echo is never a confirmation', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.badEcho = true;
  const ack = await ctx.press('mode', 'away');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
});

test('the option turned off during the fresh read: refused, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:1401'] = 600;
  const ack = ctx.fire('mode', 'away');
  await ctx.advance(300);
  await ctx.gladys.fake.configUpdated({ ...ALLOW, allow_commands: false });
  await ctx.advance(3000, 50);
  assert.equal((await ack).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the option turned off between the two writes of a manual level: the mode never leaves', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['6:1131'] = 400;
  const ack = ctx.fire('mode', 'manual-high');
  let guard = 0;
  while (ctx.unit.writes().length === 0 && guard < 500) {
    await ctx.advance(10, 10);
    guard += 1;
  }
  await ctx.gladys.fake.configUpdated({ ...ALLOW, allow_commands: false });
  await ctx.advance(5000, 50);
  assert.match(String((await ack).error), /sans confirmation/);
  assert.deepEqual(ctx.unit.writes(), [level(4)]);
});

test('a slow unit: refused unsent within the deadline', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['4:1161'] = 1500;
  const ack = await ctx.press('mode', 'away');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the stop: never behind the option, level off then manual, confirmed, then kept in /data', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.state('power').state, 0);
  assert.equal(ctx.state('current-mode').text, 'stopped');
  assert.equal(ctx.store.data.stopGuard.pending, false);
  assert.equal(ctx.store.data.stopGuard.seenOff, true);
  assert.equal(ctx.store.data.stopGuard.host, HOST);
  await nextPoll(ctx);
  assert.equal(ctx.state('fans-running').state, 0);
  assert.match(ctx.status().message.fr, /arrêt envoyé depuis Gladys est gardé/);
});

test('the stop works on an alarm, with other settings, /data broken', async (t) => {
  const ctx = await setup(t);
  ctx.unit.regs.set(15901, 1);
  setSettings(ctx.unit.regs, OTHER_SETTINGS);
  ctx.store.failSave = true;
  ctx.store.failLoad = true;
  await nextPoll(ctx);
  assert.match(ctx.status().message.fr, /ont changé/);
  assert.equal((await ctx.press('stop')).success, true);
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('a unit that does not allow the manual stop: refused, the manual mode never sent', async (t) => {
  const ctx = await setup(t);
  ctx.unit.regs.set(1353, 0);
  await nextPoll(ctx);
  assert.match(ctx.status().message.fr, /n’autorise pas l’arrêt manuel/);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Allow manual fan stop/);
  assert.deepEqual(ctx.unit.writes(), [LEVEL_OFF], 'never 1162 = 2 (another level)');
  assert.equal(ctx.unit.regs.get(1161), 0, 'still in auto');
  // A certain refusal: neither pending nor resent, never blocks the mode, said in the status.
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stopGuard, null);
  await nextPoll(ctx);
  await ctx.advance(3 * MINUTE, 200);
  assert.deepEqual(ctx.unit.writes(), [LEVEL_OFF], 'never resent');
  assert.match(ctx.status().message.fr, /refusé par la centrale \(exception 3\)/);
  await ctx.gladys.fake.configUpdated(ALLOW);
  assert.equal((await ctx.press('mode', 'away')).success, true, 'the mode follows the option');
});

test('the stop takes the line from a stuck poll (dropped, nothing of it published)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('3:12101');
  ctx.unit.regs.set(12103, 300);
  ctx.unit.regs.set(12102, 90);
  const before = ctx.gladys.fake.states.length;
  let waited = 0;
  while (!ctx.unit.log.some((r) => r.register === 12101 && r.at > NOW + 30 * SECOND)) {
    await ctx.advance(50, 50);
    waited += 1;
    assert.ok(waited < 2000, 'the poll reaches the block');
  }
  await ctx.advance(300, 50);
  assert.ok(ctx.app.active?.kind === 'read', 'a poll is stuck');
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  const dropped = ctx.gladys.fake.states
    .slice(before)
    .filter((s) => s.device_feature_external_id === feature('temperature-supply'));
  assert.deepEqual(dropped, [], 'the dropped poll published nothing');
  assert.equal(ctx.unit.maxOpen, 1, 'never two connections at once');
  assert.ok(!ctx.logs.some((l) => /next try/.test(l)), 'the dropped poll is no failure');
});

test('the stop cancels a mode not written yet; nothing sent before it leaves after it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:1401'] = 600;
  const command = ctx.fire('mode', 'manual-high');
  await ctx.advance(200);
  const stop = ctx.fire('stop');
  await ctx.advance(5000, 50);
  const [a, b] = await Promise.all([command, stop]);
  assert.equal(a.success, false);
  assert.match(String(a.error), /arrêtée entre-temps/);
  assert.equal(b.success, true, String(b.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.unit.maxOpen, 1);
  await ctx.advance(30 * SECOND, 100);
  assert.deepEqual(ctx.unit.writes(), STOP, 'the mode never leaves later');
});

test('the stop goes before the first read after a restart, and says when not sent', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0, 'no read before the interval');
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.down = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyé|pas encore envoyé/);
  assert.match(String(ack.error), /gardé/);
});

test('a stop that may not have landed is sent again at start, from /data, before the configuration', async (t) => {
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    target: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID },
    stopGuard: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID, pending: true },
  });
  const getConfig = flakyConfig(Infinity);
  const ctx = await setup(t, { store, boot: true, create: false, getConfig });
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.unit.log[0].fc, 6, 'the stop is the first request, before any read');
  assert.ok(getConfig.calls() >= 2);
  assert.equal(store.data.stopGuard.pending, false, 'confirmed: no longer pending');
  assert.equal(store.data.stopGuard.seenOff, true);
});

test('the stop works while getConfig() fails: sent to the address kept in /data', async (t) => {
  const store = memoryStore({ target: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID } });
  const ctx = await setup(t, {
    store,
    boot: true,
    create: false,
    getConfig: flakyConfig(Infinity),
  });
  assert.match(ctx.status().message.fr, /configuration n’a pas pu être lue/);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.unit.hosts.at(-1), HOST);
});

test('getConfig() failing in connected is retried, spaced, without end, then the unit is read', async (t) => {
  const ctx = await setup(t, { create: false, getConfig: flakyConfig(3) });
  assert.equal(ctx.unit.reads(), 0);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /next try in 5 s/);
  await ctx.advance(5 * SECOND, 100);
  assert.match(ctx.status().message.en, /next try in 15 s/);
  assert.equal(ctx.unit.reads(), 0);
  await ctx.advance(15 * SECOND, 100);
  await ctx.advance(32 * SECOND, 100);
  assert.ok(ctx.unit.reads() > 0, 'read once the configuration is read');
  assert.equal(ctx.status().connected, true, JSON.stringify(ctx.status()) + ctx.logs.join('\n'));
});

test('a reconnection whose getConfig() fails once keeps reading after the retry', async (t) => {
  const ctx = await setup(t);
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let fail = true;
  ctx.gladys.getConfig = async () => {
    if (fail) {
      fail = false;
      throw new Error('timeout');
    }
    return original();
  };
  await ctx.app.connectedWith(() => ctx.gladys.getConfig());
  assert.match(ctx.status().message.en, /configuration could not be read/);
  await ctx.advance(5 * SECOND + 500, 100);
  assert.equal(ctx.status().connected, true);
  const reads = ctx.unit.reads();
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.unit.reads() > reads, 'still polling');
});

test('the kept stop: sent again while not seen stopped, three sends at most, never lifted by the time', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  assert.match(ctx.app.status().fr, /pas encore confirmé/);
  await ctx.advance(10 * MINUTE, 200);
  assert.equal(stops(ctx.unit), 4, 'the stop and three resends');
  assert.match(ctx.status().message.fr, /ATTENTION/);
  await ctx.advance(3 * HOUR, 5000);
  assert.ok(ctx.app.stopGuard, 'never lifted by the time');
  assert.ok(ctx.store.data.stopGuard);
});

test('a resend that never left is not one of the three: the stop is never given up unsent', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  // Every resend finds the unit unreachable: none leaves, none counts.
  for (let i = 0; i < 5; i += 1) {
    let guard = 0;
    const logged = ctx.logs.filter((l) => /stop sent again/.test(l)).length;
    while (ctx.logs.filter((l) => /stop sent again/.test(l)).length === logged && guard < 2000) {
      await ctx.advance(50, 50);
      guard += 1;
    }
    ctx.unit.down = true;
    await ctx.advance(5 * SECOND, 100);
    ctx.unit.down = false;
  }
  assert.equal(stops(ctx.unit), 1, 'only the press left');
  assert.equal(ctx.app.stopGuard.reasserts, 0);
  assert.equal(ctx.store.data.stopGuard.reasserts, 0);
  assert.doesNotMatch(ctx.status().message.fr, /ATTENTION/);
  // The unit reachable again: the three resends leave.
  await ctx.advance(10 * MINUTE, 200);
  assert.equal(stops(ctx.unit), 4);
  assert.equal(ctx.app.stopGuard.reasserts, 3);
});

test('the kept stop: running twice in a row after seen stopped = started elsewhere, lifted; once = kept', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.run();
  await nextPoll(ctx);
  assert.ok(ctx.app.stopGuard, 'one read running: still kept');
  ctx.unit.halt();
  await ctx.advance(MINUTE, 100);
  ctx.unit.run();
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.app.stopGuard, 'running, stopped, running: still kept');
  await ctx.advance(MINUTE, 100);
  assert.equal(ctx.app.stopGuard, undefined, 'running twice in a row: lifted');
  assert.equal(ctx.store.data.stopGuard, null);
  assert.deepEqual(ctx.unit.writes(), STOP, 'no resend after it was seen stopped');
  assert.equal(
    (await ctx.press('mode', 'away')).success,
    true,
    'the mode follows the option again',
  );
});

test('the kept stop refuses the mode; "Start the ventilation" lifts it (saved before its byte)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  const refused = await ctx.press('mode', 'away');
  assert.match(String(refused.error), /arrêt envoyé depuis Gladys est gardé/);
  ctx.store.failSave = true;
  const blocked = await ctx.press('start');
  assert.equal(blocked.success, false);
  assert.match(String(blocked.error), /\/data/);
  assert.deepEqual(ctx.unit.writes(), STOP, '/data not written: nothing sent');
  assert.ok(ctx.app.stopGuard);
  ctx.store.failSave = false;
  const ack = await ctx.press('start');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [...STOP, START]);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stopGuard, null);
  await ctx.advance(3 * MINUTE, 200);
  assert.deepEqual(ctx.unit.writes(), [...STOP, START], 'never stopped again by the reads');
});

test('a stop after a start not confirmed is sticky: resent even after seen stopped', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.halt();
  ctx.unit.ignoreWrites = true;
  await ctx.press('start');
  ctx.unit.ignoreWrites = false;
  assert.equal((await ctx.press('stop')).success, true);
  assert.equal(ctx.app.stopGuard.sticky, true);
  // The late start lands after the stop.
  ctx.unit.run();
  await ctx.advance(30 * SECOND, 100);
  assert.equal(stops(ctx.unit), 2, 'stopped again');
  assert.equal(ctx.unit.regs.get(1351), 0);
});

test('never read sooner than the interval: button, scan, reconnection, same config', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.unit.reads();
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /Prochaine lecture/);
  await ctx.gladys.fake.scanRequest();
  await ctx.app.connected(CFG);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(1000);
  assert.equal(ctx.unit.reads(), reads);
  await nextPoll(ctx);
  assert.ok(ctx.unit.reads() > reads, 'read again after the interval');
});

test('a restart waits for the interval after the last read kept in /data', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 30 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0);
  await ctx.advance(MINUTE + 31 * SECOND, 100);
  assert.ok(ctx.unit.reads() > 0);
  assert.ok(store.data.lastAttemptAt > NOW, 'the time of the read kept before it');
});

test('an unreachable unit: status says so, retried with a backoff, device unreachable', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await nextPoll(ctx);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.fr, /Vérifiez l’adresse, la passerelle/);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  const tries = ctx.unit.connections;
  await ctx.advance(30 * SECOND, 500);
  assert.equal(ctx.unit.connections, tries, 'never sooner than the interval');
  // The stop does not wait for the backoff.
  ctx.unit.down = false;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('a secondary block refused or silent never blocks the values (skipped for an hour)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.exceptions.add('4:15901');
  ctx.unit.regs.set(12103, 200);
  await nextPoll(ctx);
  assert.ok(ctx.logs.some((l) => /block alarms refused/.test(l)));
  assert.equal(ctx.state('temperature-supply').state, 20);
  assert.equal(ctx.status().connected, true);
  const before = ctx.unit.log.filter((r) => r.register === 15901).length;
  await ctx.advance(2 * MINUTE, 100);
  assert.equal(ctx.unit.log.filter((r) => r.register === 15901).length, before, 'skipped');
  // The identity block never answers: the values before it are still published.
  ctx.unit.silent.add('3:1401');
  for (let i = 0; i < 4; i += 1) {
    ctx.unit.regs.set(12103, 210 + i);
    await ctx.advance(MINUTE + 3 * SECOND, 100);
    assert.equal(ctx.state('temperature-supply').state, 21 + i / 10, ctx.logs.slice(-8).join('\n'));
  }
  assert.ok(
    ctx.logs.some((l) => /identity never answers/.test(l)),
    ctx.logs.join('\n'),
  );
  assert.equal(ctx.status().connected, true);
});

test('frames in chunks are read; an answer to another transaction ends the read', async (t) => {
  const unit = fakeSystemair();
  unit.split = true;
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  unit.split = false;
  unit.wrongTransaction = true;
  unit.regs.set(12103, 200);
  await ctx.advance(MINUTE + 4 * SECOND, 50);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.status().connected, false);
});

test('other fan level settings: commands refused, the test button accepts them', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  setSettings(ctx.unit.regs, OTHER_SETTINGS);
  await nextPoll(ctx);
  assert.match(ctx.status().message.fr, /ont changé/);
  assert.match(String((await ctx.press('mode', 'away')).error), /réglages des niveaux/);
  assert.deepEqual(ctx.unit.writes(), []);
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /acceptée/);
  assert.notEqual(ctx.store.data.identity.fingerprint, FINGERPRINT);
  assert.equal((await ctx.press('mode', 'away')).success, true);
});

test('/data unreadable: no identity learnt, nothing written over it, commands refused', async (t) => {
  const store = memoryStore({ identity: { unit: UNIT, fingerprint: '0'.repeat(40) } });
  store.failLoad = true;
  const ctx = await setup(t, { store, config: ALLOW });
  assert.equal(ctx.state('temperature-supply').state, 18.5, 'still read');
  assert.equal(store.saves, 0, 'never written over');
  assert.match(ctx.status().message.fr, /\/data illisible/);
  assert.match(String((await ctx.press('mode', 'away')).error), /\/data/);
  assert.deepEqual(ctx.unit.writes(), []);
  assert.deepEqual(store.data.identity, { unit: UNIT, fingerprint: '0'.repeat(40) });
  assert.equal(ctx.app.memory.identity, null, 'nothing learnt over it');
});

test('/data that never answers: unreadable after its bound, the reads go on, the stop leaves', async (t) => {
  const store = memoryStore();
  store.hang = true;
  const ctx = await setup(t, { store, config: ALLOW, first: 5000 });
  assert.equal(ctx.app.memoryUnreadable, true);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.match(ctx.status().message.fr, /\/data illisible/);
  assert.match(String((await ctx.press('mode', 'away')).error), /\/data/);
  assert.equal((await ctx.press('stop')).success, true);
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('a /data write that never answers never holds a command: the start is refused in time', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  store.hang = true;
  const ack = ctx.fire('start');
  let settled = false;
  ack.then(() => (settled = true));
  await ctx.advance(4400, 20);
  assert.ok(settled, 'answered within 5 s');
  assert.match(String((await ack).error), /\/data|trop lentement/);
  assert.deepEqual(ctx.unit.writes(), STOP, 'nothing written');
  store.hang = false;
  await ctx.advance(5 * SECOND, 100);
  const again = await ctx.press('start');
  assert.equal(again.success, true, 'never left "busy"');
});

test('a new address keeps the device; a stop of the old one is not shown for the new one', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('stop')).success, true);
  const updating = ctx.gladys.fake.configUpdated({ host: '192.168.1.81' });
  await ctx.advance(2000, 50);
  await updating;
  assert.doesNotMatch(ctx.status().message.fr, /gardé/);
  assert.equal(ctx.unit.hosts.at(-1), '192.168.1.81');
  assert.equal(ctx.gladys.fake.discoveredDevices.at(-1).external_id, DEVICE);
});

test('the clean shutdown keeps the state in /data', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('stop')).success, true);
  const saves = ctx.store.saves;
  await ctx.app.shutdown();
  assert.ok(ctx.store.saves > saves);
  assert.equal(ctx.store.data.stopGuard.unit, UNIT);
});

test('a stop whose /data write is slow still cancels a mode about to be written', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  const save = store.save.bind(store);
  store.save = (data) => new Promise((resolve) => setTimeout(() => resolve(save(data)), 120));
  ctx.unit.delays['3:1401'] = 60;
  const command = ctx.fire('mode', 'away');
  await ctx.advance(60, 5);
  const stop = ctx.fire('stop');
  await ctx.advance(5000, 20);
  const [a, b] = await Promise.all([command, stop]);
  assert.equal(a.success, false);
  assert.match(String(a.error), /arrêtée entre-temps/);
  assert.equal(b.success, true, String(b.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
});

test('/data frozen: several stops in a row each leave at once, none waits for it', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  store.hang = true;
  ctx.unit.ignoreWrites = true;
  for (let i = 1; i <= 3; i += 1) {
    const pressed = Date.now();
    const ack = ctx.fire('stop');
    let guard = 0;
    while (stops(ctx.unit) < i && guard < 200) {
      await ctx.advance(10, 10);
      guard += 1;
    }
    assert.equal(stops(ctx.unit), i, `stop ${i} left`);
    assert.ok(
      Date.now() - pressed < 400,
      `stop ${i} left ${Date.now() - pressed} ms after its press`,
    );
    await ctx.advance(5000, 50);
    assert.match(String((await ack).error), /sans confirmation/);
  }
});

test('a kept stop appearing during the fresh read refuses the mode (checked again after the read)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:1401'] = 200;
  const command = ctx.fire('mode', 'away');
  await ctx.advance(100, 10);
  ctx.app.stopGuard = {
    unit: UNIT,
    host: HOST,
    port: 502,
    unitId: UNIT_ID,
    sentAt: ctx.app.mono(),
    pending: false,
    seenOff: true,
    onReads: 0,
    reasserts: 0,
    sticky: false,
  };
  await ctx.advance(5000, 50);
  const ack = await command;
  assert.match(String(ack.error), /arrêt envoyé depuis Gladys est gardé/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('"Start the ventilation" on a ventilation already running lifts the kept stop, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  ctx.unit.ignoreWrites = false;
  assert.ok(ctx.app.stopGuard);
  const writes = ctx.unit.writes().length;
  const ack = await ctx.press('start');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stopGuard, null);
  assert.equal(ctx.unit.writes().length, writes, 'already running: nothing written');
});

test('a start newer than the kept stop lifts it at the next read (never resent over it)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.app.stopGuard = {
    unit: UNIT,
    host: HOST,
    port: 502,
    unitId: UNIT_ID,
    sentAt: ctx.app.mono(),
    pending: true,
    seenOff: false,
    onReads: 0,
    reasserts: 0,
    sticky: false,
  };
  ctx.app.lastStartAt = ctx.app.mono();
  await nextPoll(ctx);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a stop not confirmed, then read stopped, then running twice: lifted, never resent', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  const ack = ctx.fire('stop');
  await ctx.advance(4500, 50);
  assert.match(String((await ack).error), /sans confirmation/);
  ctx.unit.ignoreWrites = false;
  ctx.unit.halt(); // stopped on its panel, or the stop landed late
  await ctx.advance(6 * SECOND, 100);
  assert.equal(ctx.store.data.stopGuard.seenOff, true);
  assert.equal(ctx.store.data.stopGuard.pending, false);
  ctx.unit.run();
  await ctx.advance(2 * MINUTE + 4 * SECOND, 100);
  assert.equal(ctx.app.stopGuard, undefined, 'started elsewhere: lifted');
  assert.deepEqual(ctx.unit.writes(), STOP, 'never resent once seen stopped');
});

test('the period is start to start, even with a slow unit', async (t) => {
  const ctx = await setup(t);
  ctx.unit.delay = 200;
  const starts = [];
  const log = ctx.unit.log;
  const push = log.push.bind(log);
  log.push = (entry) => {
    if (entry.register === 1161 && entry.fc === 4) starts.push(Date.now());
    return push(entry);
  };
  await ctx.advance(4 * MINUTE + 5 * SECOND, 100);
  const gaps = starts.slice(1).map((v, i) => v - starts[i]);
  assert.ok(gaps.length >= 3, `${gaps.length} gaps`);
  for (const gap of gaps) {
    assert.ok(gap >= MINUTE && gap <= MINUTE + 200, `gap ${gap} ms`);
  }
});

test('unit id 1 by default; an answer with another unit id is accepted', async (t) => {
  const unit = fakeSystemair();
  const handle = unit.handle;
  unit.handle = (socket, frame) => {
    // A gateway that answers with its own id (247) whatever is asked.
    const emit = socket.emit.bind(socket);
    socket.emit = (event, data) => {
      if (event === 'data') {
        const out = Buffer.from(data);
        out[6] = 247;
        return emit(event, out);
      }
      return emit(event, data);
    };
    return handle(socket, frame);
  };
  const ctx = await setup(t, { unit });
  assert.equal(ctx.unit.log[0].uid, 1);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.status().connected, true);
  assert.ok(ctx.logs.some((l) => /unit id 247 \(accepted; 1 asked\)/.test(l)));
  assert.equal((await ctx.press('stop')).success, true);
});

for (const key of ['4:15901', '4:7005', '3:1401']) {
  test(`block ${key} closing the connection never costs the values`, async (t) => {
    const ctx = await setup(t);
    ctx.unit.closeOn.add(key);
    ctx.unit.regs.set(12103, 200);
    await nextPoll(ctx);
    assert.equal(ctx.state('temperature-supply').state, 20);
    assert.equal(ctx.status().connected, true);
    assert.ok(ctx.logs.some((l) => /failed \(closed\), tried again every hour/.test(l)));
    const register = Number(key.split(':')[1]);
    const tries = ctx.unit.log.filter((r) => r.register === register).length;
    ctx.unit.regs.set(12103, 210);
    await nextPoll(ctx);
    assert.equal(ctx.state('temperature-supply').state, 21);
    assert.equal(ctx.unit.log.filter((r) => r.register === register).length, tries, 'skipped');
  });
}

test('a state block closing the connection is a failed read (nothing half published)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.closeOn.add('3:1131');
  ctx.unit.regs.set(1161, 5);
  await nextPoll(ctx);
  assert.equal(ctx.status().connected, false);
  assert.equal(ctx.state('current-mode').text, 'auto', 'the mode of that read is not applied');
});

test('a command pressed while a poll writes /data: one connection at a time', async (t) => {
  const store = memoryStore({ identity: { unit: UNIT, fingerprint: FINGERPRINT } });
  const ctx = await setup(t, { config: ALLOW, store });
  const save = store.save.bind(store);
  store.save = (data) => new Promise((resolve) => setTimeout(() => resolve(save(data)), 300));
  ctx.unit.delay = 60;
  await ctx.advance(ctx.app.due - ctx.app.mono() + 50, 10);
  // The poll is due and waits for /data; the command arrives meanwhile.
  const ack = ctx.fire('mode', 'away');
  await ctx.advance(5000, 10);
  assert.equal((await ack).success, true);
  assert.equal(ctx.unit.maxOpen, 1);
});

test('a read asked between two tries of the stop waits for it', async (t) => {
  const ctx = await setup(t);
  ctx.unit.closeOnWrite = 1;
  const ack = ctx.fire('stop');
  await ctx.advance(60, 5);
  ctx.app.tick().catch(() => {});
  await ctx.advance(200, 5);
  ctx.app.tick().catch(() => {});
  await ctx.advance(5000, 20);
  assert.equal((await ack).success, true);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.equal(stops(ctx.unit), 2);
});

test('an unknown mode between two "running" reads resets the count (kept)', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.run();
  await nextPoll(ctx);
  ctx.unit.regs.set(1161, 77);
  await ctx.advance(MINUTE, 100);
  ctx.unit.run();
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.app.stopGuard, 'running, unknown, running: still kept');
  await ctx.advance(MINUTE, 100);
  assert.equal(ctx.app.stopGuard, undefined);
});

test('the stop retries a refused connection until it is accepted', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  setTimeout(() => (ctx.unit.down = false), 1000);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.ok(ctx.unit.refused >= 2);
});

test('the kept stop is in /data before the first byte; a /data that never answers never holds it', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  let atWrite;
  ctx.unit.onWrite = () => {
    atWrite ??= store.data?.stopGuard;
  };
  assert.equal((await ctx.press('stop')).success, true);
  assert.equal(atWrite?.pending, true);
  store.save = () => new Promise(() => {});
  ctx.unit.run();
  const sent = [];
  ctx.unit.onWrite = () => sent.push(Date.now());
  const pressed = Date.now();
  assert.equal((await ctx.press('stop')).success, true);
  assert.ok(sent[0] - pressed < 400, `written ${sent[0] - pressed} ms after the press`);
});

test('the ack comes within 5 s; a write that cannot leave by 3.5 s is refused unsent', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['4:1161'] = 100;
  let settled = false;
  ctx.unit.onWrite = () => {
    ctx.unit.delays['4:1161'] = 9000;
  };
  const ack = ctx.fire('mode', 'away');
  ack.then(() => (settled = true));
  await ctx.advance(4400, 20);
  assert.ok(settled, 'answered by 4.4 s');
  assert.match(String((await ack).error), /sans confirmation/);
  // The start lifting a kept stop: a slow /data pushes its write past 3.5 s.
  ctx.unit.delays = {};
  ctx.unit.onWrite = undefined;
  await ctx.advance(30 * SECOND, 100);
  assert.equal((await ctx.press('stop')).success, true);
  const writes = ctx.unit.writes().length;
  for (const key of ['4:1161', '3:1131', '3:1401']) ctx.unit.delays[key] = 900;
  const save = ctx.store.save.bind(ctx.store);
  ctx.store.save = (data) => new Promise((resolve) => setTimeout(() => resolve(save(data)), 1000));
  const start = await ctx.press('start');
  assert.match(String(start.error), /trop lentement/);
  assert.equal(ctx.unit.writes().length, writes, 'nothing written');
  assert.ok(ctx.app.stopGuard, 'still kept');
  await ctx.advance(500, 50);
  assert.ok(ctx.store.data.stopGuard, '/data keeps the stop again');
});

test('the time of a read is in /data before it; settings unreadable refuse', async (t) => {
  const store = memoryStore({ identity: { unit: UNIT, fingerprint: FINGERPRINT } });
  const unit = fakeSystemair();
  const savedAt = [];
  const save = store.save.bind(store);
  store.save = (data) => {
    savedAt.push(unit.log.length);
    return save(data);
  };
  const ctx = await setup(t, { config: ALLOW, store, unit });
  assert.equal(savedAt[0], 0, 'saved before the first request');
  assert.ok(store.data.lastAttemptAt >= NOW);
  ctx.unit.exceptions.add('3:1401');
  assert.match(String((await ctx.press('mode', 'away')).error), /relu/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('mode list filter, pending default, the 90 s guard', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(1161, 7);
  await nextPoll(ctx);
  assert.equal(ctx.state('current-mode').text, 'cooker-hood');
  assert.equal(ctx.state('mode').text, 'auto', 'cooker hood is not in the list');
  ctx.unit.regs.set(1161, 0);
  assert.equal(
    normalizeMemory({ stopGuard: { unit: 'u', host: 'h', unitId: 1 } }, NOW).stopGuard.pending,
    true,
  );
  // Away not applied: "auto" (as read) is still written under its guard (away may land), not after 90 s.
  ctx.unit.ignoreWrites = true;
  await ctx.press('mode', 'away');
  ctx.unit.ignoreWrites = false;
  assert.equal((await ctx.press('mode', 'auto')).success, true);
  assert.equal(ctx.unit.writes().length, 2, 'rewritten under the guard');
  await ctx.advance(91 * SECOND, 500);
  assert.equal((await ctx.press('mode', 'auto')).success, true);
  assert.equal(ctx.unit.writes().length, 2, 'already so after the guard');
  // An unconfirmed away, then 91 s: its guard is gone, "auto" (as read) is already so.
  ctx.unit.ignoreWrites = true;
  await ctx.press('mode', 'away');
  ctx.unit.ignoreWrites = false;
  const writes = ctx.unit.writes().length;
  await ctx.advance(91 * SECOND, 500);
  assert.equal((await ctx.press('mode', 'auto')).success, true);
  assert.equal(ctx.unit.writes().length, writes, 'the guard ended: nothing written');
});

test('a sticky stop stays sticky when resent, the resend a second after the read', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.halt();
  ctx.unit.ignoreWrites = true;
  await ctx.press('start');
  ctx.unit.ignoreWrites = false;
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.run();
  await ctx.advance(30 * SECOND, 100);
  const resend = ctx.unit.log.filter((e) => e.fc === 6).at(-2);
  assert.equal(ctx.app.stopGuard.sticky, true);
  const before = ctx.unit.log.filter((e) => e.fc === 3 && e.at < resend.at).at(-1);
  assert.ok(resend.at - before.at >= SECOND, `resent ${resend.at - before.at} ms after the read`);
});

test('a poll due while a command holds the line runs a second after it, never in a loop', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  let runs = 0;
  const run = ctx.app.run.bind(ctx.app);
  ctx.app.run = () => {
    runs += 1;
    return run();
  };
  await ctx.advance(ctx.app.due - ctx.app.mono() - 300, 50);
  for (const key of ['4:1161', '3:1131', '3:1401']) ctx.unit.delays[key] = 900;
  const before = runs;
  const ack = ctx.fire('mode', 'away');
  let done = false;
  ack.then(() => (done = true));
  while (!done) await ctx.advance(10, 10);
  assert.ok(runs - before <= 6, `${runs - before} runs`);
  ctx.unit.delays = {};
  const polls = ctx.unit.log.length;
  await ctx.advance(2500, 50);
  assert.ok(
    ctx.unit.log.slice(polls).some((r) => r.fc === 4 && r.register === 14001),
    'the postponed poll ran right after the command',
  );
});

test('an invalid configuration does not stop the stop (address of /data)', async (t) => {
  const ctx = await setup(t);
  await ctx.gladys.fake.configUpdated({ host: 'bad host!' });
  await ctx.advance(500, 50);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(ctx.unit.hosts.at(-1), HOST);
});

test('a start refused by the unit keeps the stop kept', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.exceptions.add('6:1162');
  const ack = await ctx.press('start');
  assert.match(String(ack.error), /a refusé/);
  assert.ok(ctx.app.stopGuard);
  assert.ok(ctx.store.data.stopGuard);
});

test('a new press resets the resends; a press at the end of a stop starts a new one', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  await ctx.advance(6 * MINUTE, 200);
  assert.equal(ctx.app.stopGuard.reasserts, 3);
  await ctx.press('stop');
  assert.equal(ctx.app.stopGuard.reasserts, 0, 'a press starts the count again');
  // A press 3 s into a stop that cannot write: it gets its own stop after it.
  ctx.unit.ignoreWrites = false;
  ctx.unit.closeOnWrite = 1000;
  const first = ctx.fire('stop');
  await ctx.advance(3000, 20);
  const second = ctx.fire('stop');
  await ctx.advance(700, 20);
  ctx.unit.closeOnWrite = 0;
  await ctx.advance(6000, 20);
  assert.equal((await first).success, false);
  assert.equal((await second).success, true, 'the late press sent its own stop');
});

test('the start is refused between two tries of a stop', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.halt();
  ctx.unit.closeOnWrite = 1;
  const stop = ctx.fire('stop');
  await ctx.advance(60, 5);
  assert.equal(ctx.app.active, undefined, 'in the gap between two tries');
  const start = ctx.fire('start');
  await ctx.advance(5000, 20);
  assert.match(String((await start).error), /arrêtée entre-temps/);
  assert.equal((await stop).success, true);
  assert.ok(!ctx.unit.writes().some((w) => w.register === 1162 && w.value === 1), 'no start');
});

test('/data repairs a time in the future, an unreadable count is 0, a bad fingerprint is none', () => {
  assert.equal(normalizeMemory({ lastAttemptAt: NOW + HOUR }, NOW).lastAttemptAt, NOW);
  const guard = { unit: 'u', host: 'h', unitId: 1 };
  for (const junk of ['3', -1, 2.5, null, 'x']) {
    assert.equal(
      normalizeMemory({ stopGuard: { ...guard, reasserts: junk } }, NOW).stopGuard.reasserts,
      0,
    );
  }
  assert.equal(
    normalizeMemory({ stopGuard: { ...guard, reasserts: 99 } }, NOW).stopGuard.reasserts,
    3,
  );
  assert.equal(normalizeMemory({ identity: { unit: 'u', fingerprint: 'zz' } }, NOW).identity, null);
  assert.equal(normalizeMemory({ stopGuard: { ...guard, unitId: 248 } }, NOW).stopGuard, null);
});

test('a state block that keeps timing out is never skipped', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('3:1131');
  for (let i = 0; i < 4; i += 1) await ctx.advance(MINUTE, 100);
  ctx.unit.silent.clear();
  ctx.unit.regs.set(12103, 250);
  await ctx.advance(MINUTE + 3 * SECOND, 100);
  assert.equal(ctx.state('temperature-supply').state, 25);
});

test('unreadable settings are never "another unit"', async (t) => {
  const ctx = await setup(t);
  ctx.unit.exceptions.add('3:1401');
  await nextPoll(ctx);
  assert.ok(!ctx.logs.some((l) => /settings changed/.test(l)));
  assert.doesNotMatch(ctx.status().message.fr, /ont changé/);
});

test('values out of the bounds of their feature are never published', () => {
  const ids = { feature: (role) => role };
  const states = deviceStates(ids, {
    humidity: 150,
    fanSupply: 101,
    filterDays: -1,
    supply: 130,
    setpoint: 40,
    alarmA: 2,
    mode: 'off',
    modeChoice: 'manual-off',
  });
  assert.deepEqual(states, []);
});

test('two commands at once: the second is refused busy', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const a = ctx.fire('mode', 'away');
  const b = ctx.fire('mode', 'holiday');
  await ctx.advance(5000, 20);
  assert.equal((await a).success, true);
  assert.match(String((await b).error), /encore en cours/);
  assert.equal(ctx.unit.writes().length, 1);
});

test('a resend planned before a start pressed in its second is dropped', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  ctx.unit.ignoreWrites = false;
  let guard = 0;
  while (!ctx.logs.some((l) => /stop sent again/.test(l)) && guard < 2000) {
    await ctx.advance(10, 5);
    guard += 1;
  }
  // The ventilation runs: the start is "already so" and lifts the kept stop.
  const start = ctx.fire('start');
  await ctx.advance(5000, 20);
  assert.equal((await start).success, true);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(stops(ctx.unit), 1, 'the resend never left');
  assert.equal(ctx.unit.regs.get(1351), 1);
});

// --- Review r1 ---------------------------------------------------------------

/** Waits (mocked time) until the next resend of the stop is logged. */
async function untilResend(ctx) {
  const logged = ctx.logs.filter((l) => /stop sent again/.test(l)).length;
  for (let i = 0; i < 3000; i += 1) {
    if (ctx.logs.filter((l) => /stop sent again/.test(l)).length > logged) return;
    await ctx.advance(50, 50);
  }
  assert.fail('no resend');
}

test('r1 B1: a resend the unit never answered is not counted (gateway taken, no answer)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  const before = stops(ctx.unit);
  // Another master holds the gateway: connections accepted then closed at once.
  for (let i = 0; i < 2; i += 1) {
    await untilResend(ctx);
    ctx.unit.dropConnections = 1000;
    await ctx.advance(5 * SECOND, 100);
    ctx.unit.dropConnections = 0;
  }
  // The write leaves but never gets an answer.
  for (let i = 0; i < 2; i += 1) {
    await untilResend(ctx);
    ctx.unit.silent.add('6:1131');
    await ctx.advance(5 * SECOND, 100);
    ctx.unit.silent.clear();
  }
  assert.ok(stops(ctx.unit) > before, 'some bytes were handed to the gateway');
  assert.equal(ctx.app.stopGuard.reasserts, 0, 'none answered, none counted');
  assert.doesNotMatch(ctx.status().message.fr, /ATTENTION/);
  // The gateway free again: the stop reaches the unit and is applied.
  ctx.unit.ignoreWrites = false;
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(ctx.unit.regs.get(1351), 0, 'stopped at last');
  assert.equal(ctx.app.stopGuard.seenOff, true);
});

test('r1 B1: a resend refused by an exception counts (the unit answered)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  ctx.unit.exceptions.add('6:1131');
  ctx.unit.exceptionCode = 4;
  await ctx.advance(10 * MINUTE, 200);
  assert.equal(ctx.app.stopGuard.reasserts, 3);
});

test('r1 I1: a mode confirmed by a follow-up read never makes a later stop sticky', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  // Away is applied 2 s after its write: "not applied yet", then the 5 s read shows it.
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('mode', 'away', 2 * SECOND);
  ctx.unit.ignoreWrites = false;
  ctx.unit.run(5, 3);
  assert.match(String((await ack).error), /pas encore appliquée/);
  await ctx.advance(8 * SECOND, 50);
  assert.equal(ctx.app.guards.size, 0, 'the follow-up read lifted the guard');
  assert.equal(ctx.app.startOpen, false);
  await ctx.advance(14 * SECOND, 100);
  assert.equal((await ctx.press('stop')).success, true);
  assert.equal(ctx.app.stopGuard.sticky, false);
  // Started again on the panel: never stopped again by Gladys.
  ctx.unit.run();
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(stops(ctx.unit), 1);
  assert.equal(ctx.app.stopGuard, undefined, 'started elsewhere: lifted');
});

test('r1 I1: the sticky window ends; a new press never inherits it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.halt();
  ctx.unit.ignoreWrites = true;
  await ctx.press('start');
  ctx.unit.ignoreWrites = false;
  assert.equal((await ctx.press('stop')).success, true);
  assert.equal(ctx.app.stopGuard.sticky, true);
  // After its 90 s window, a read sees the stop applied: no longer sticky.
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(ctx.app.stopGuard.sticky, false);
  ctx.unit.run();
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(stops(ctx.unit), 1, 'a start on the panel is never fought');
  // A new press after a sticky one starts unsticky.
  ctx.unit.halt();
  ctx.unit.ignoreWrites = true;
  await ctx.press('start');
  ctx.unit.ignoreWrites = false;
  await ctx.press('stop');
  ctx.app.guards.clear();
  ctx.app.startOpen = false;
  await ctx.press('stop');
  assert.equal(ctx.app.stopGuard.sticky, false, 'not carried by a press');
});

test('r1 m5 (M25): a stop pressed while a mode write waits for its echo is sticky', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['6:1162'] = 800;
  const mode = ctx.fire('mode', 'away');
  for (let i = 0; i < 300 && ctx.unit.writes().length === 0; i += 1) await ctx.advance(10, 10);
  assert.equal(ctx.app.guards.size, 0, 'no guard yet: only the write in flight');
  const stop = ctx.fire('stop');
  await ctx.advance(5 * SECOND, 50);
  await Promise.all([mode, stop]);
  assert.equal(ctx.app.stopGuard.sticky, true);
});

test('r1 I2: a start waiting for a frozen /data never holds the stop back', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.run();
  store.hang = true;
  const start = ctx.fire('start');
  await ctx.advance(150, 10);
  const pressed = Date.now();
  const before = stops(ctx.unit);
  const stop = ctx.fire('stop');
  for (let i = 0; i < 100 && stops(ctx.unit) === before; i += 1) await ctx.advance(10, 10);
  assert.ok(stops(ctx.unit) > before, 'the stop left');
  const at = ctx.unit.log.filter((r) => r.fc === 6 && r.register === 1131).at(-1).at;
  assert.ok(at - pressed < 300, `first byte ${at - pressed} ms after the press`);
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await start).success, false);
  await stop;
  assert.equal(ctx.unit.maxOpen, 1, 'never two connections');
  assert.ok(!ctx.unit.writes().some((w) => w.register === 1162 && w.value === 1), 'no start');
});

test('r1 m2: a pending stop of a previous address goes to the current one at boot', async (t) => {
  const OLD = '192.168.1.99';
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    target: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID },
    stopGuard: { unit: `${OLD}#1`, host: OLD, port: 502, unitId: UNIT_ID, pending: true },
  });
  const ctx = await setup(t, { store, boot: true, create: false });
  assert.ok(!ctx.unit.hosts.includes(OLD), 'never written to the old address');
  assert.deepEqual(ctx.unit.writes(), STOP);
  assert.equal(store.data.stopGuard.host, HOST);
  assert.match(ctx.app.status().fr, /arrêt envoyé depuis Gladys/);
});

test('r1 m2: a new address takes a pending stop with it, forgets a confirmed one', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  const updating = ctx.gladys.fake.configUpdated({ host: '192.168.1.81' });
  await ctx.advance(2000, 50);
  await updating;
  assert.equal(ctx.app.stopGuard.host, '192.168.1.81');
  assert.match(ctx.status().message.fr, /pas encore confirmé/);
});

test('r1 m3: a stop whose connection closes before any answer says so', async (t) => {
  const ctx = await setup(t);
  ctx.unit.closeOnWrite = 1000;
  const ack = await ctx.press('stop');
  assert.match(String(ack.error), /sans réponse de la centrale/);
  assert.match(String(ack.error), /gardé/);
});

test('r1 m4: SAVE Connect: a command and a stop are paced like the reads', async (t) => {
  const unit = fakeSystemair({ saveConnect: true });
  const ctx = await setup(t, { unit, config: { ...ALLOW, gateway: 'save-connect' }, first: 5000 });
  const from = ctx.unit.log.length;
  assert.equal((await ctx.press('mode', 'manual-high')).success, true);
  const gaps = ctx.unit.log.slice(from + 1).map((r, i) => r.at - ctx.unit.log[from + i].at);
  assert.ok(gaps.length >= 8, `${gaps.length} requests`);
  assert.ok(
    gaps.every((g) => g >= 100),
    `gaps ${gaps}`,
  );
  const stopFrom = ctx.unit.log.length;
  assert.equal((await ctx.press('stop')).success, true);
  const stopGaps = ctx.unit.log
    .slice(stopFrom + 1)
    .map((r, i) => r.at - ctx.unit.log[stopFrom + i].at);
  assert.ok(
    stopGaps.every((g) => g >= 100),
    `gaps ${stopGaps}`,
  );
});

test('r1 m5 (M23): the manual mode never leaves without the echo of the level off', async (t) => {
  const ctx = await setup(t);
  ctx.unit.badEchoOn.add('6:1131');
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.ok(stops(ctx.unit) >= 1);
  assert.ok(!ctx.unit.writes().some((w) => w.register === 1162), 'never 1162 = 2');
});
