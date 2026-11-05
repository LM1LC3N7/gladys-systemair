// -----------------------------------------------------------------------------
// The Modbus layer, pure: requests, decoders of Systemair's list, the derived
// values, the writes allowed, the MBAP session; and the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { BLOCKS, BLOCK_OF, COMMANDS, FC, FEATURES } from '../src/constants.js';
import { ERROR_KINDS, ModbusSession } from '../src/modbus/client.js';
import {
  ALLOWED_WRITES,
  decodeBlock,
  derive,
  isEcho,
  parseRead,
  readRequest,
  writeRequest,
} from '../src/modbus/protocol.js';

/** The words of a block from a map of register numbers (0 elsewhere). */
const words = (block, regs) =>
  Array.from({ length: block.count }, (_, i) => regs[block.register + i] ?? 0);
const decode = (key, regs) => decodeBlock(BLOCK_OF[key], words(BLOCK_OF[key], regs));

test('read requests: function 3 or 4, protocol address = register - 1', () => {
  assert.deepEqual(
    [...readRequest({ fc: FC.READ_INPUT, address: 1160, count: 1 })],
    [4, 4, 136, 0, 1],
  );
  assert.deepEqual(
    [...readRequest({ fc: FC.READ_HOLDING, address: 1130, count: 1 })],
    [3, 4, 106, 0, 1],
  );
  assert.throws(() => readRequest({ fc: 6, address: 0, count: 1 }));
  for (const block of BLOCKS) {
    assert.equal(block.address, block.register - 1);
    assert.ok(block.count >= 1 && block.count <= 10);
  }
});

test('parseRead: only the exact size and function asked', () => {
  const ask = { fc: 4, count: 2 };
  assert.deepEqual(parseRead(ask, Buffer.from([4, 4, 0, 1, 0, 2])), [1, 2]);
  assert.equal(parseRead(ask, Buffer.from([4, 2, 0, 1])), undefined);
  assert.equal(parseRead(ask, Buffer.from([3, 4, 0, 1, 0, 2])), undefined);
  assert.equal(parseRead(ask, Buffer.from([4, 4, 0, 1, 0, 2, 0])), undefined);
  assert.equal(parseRead({ fc: 6, count: 1 }, Buffer.from([6, 2, 0, 1])), undefined);
});

test('decode: mode, manual level; unknown values left out', () => {
  assert.deepEqual(decode('mode', { 1161: 0 }), { mode: 'auto' });
  assert.deepEqual(decode('mode', { 1161: 12 }), { mode: 'pressure-guard' });
  assert.deepEqual(decode('mode', { 1161: 13 }), {});
  assert.deepEqual(decode('manual', { 1131: 0 }), { manualLevel: 'off' });
  assert.deepEqual(decode('manual', { 1131: 4 }), { manualLevel: 'high' });
  assert.deepEqual(decode('manual', { 1131: 1 }), {}, '1 is not a level of the list');
  assert.deepEqual(decode('manual', { 1131: 5 }), {});
});

test('derive: stopped only in manual at level off; the mode choice; never from a missing value', () => {
  assert.deepEqual(derive({ mode: 'auto' }), { mode: 'auto', power: true, modeChoice: 'auto' });
  assert.deepEqual(derive({ mode: 'manual', manualLevel: 'off' }), {
    mode: 'manual',
    manualLevel: 'off',
    power: false,
  });
  assert.equal(derive({ mode: 'manual', manualLevel: 'normal' }).modeChoice, 'manual-normal');
  assert.deepEqual(derive({ mode: 'manual' }), { mode: 'manual' }, 'level unknown: power unknown');
  assert.deepEqual(derive({ manualLevel: 'off' }), { manualLevel: 'off' });
  const cooker = derive({ mode: 'cooker-hood', manualLevel: 'off' });
  assert.equal(cooker.power, true);
  assert.equal(cooker.modeChoice, undefined, 'not in the list');
  // Stale derived values are recomputed.
  assert.equal(derive({ mode: 'auto', power: false, modeChoice: 'away' }).modeChoice, 'auto');
});

test('decode: signed tenths in the list range, percentages, flags', () => {
  const t = decode('temperatures', { 12102: 0x10000 - 52, 12103: 185 });
  assert.deepEqual(t, { outdoor: -5.2, supply: 18.5 });
  assert.deepEqual(decode('temperatures', { 12102: 801, 12103: 0x10000 - 401 }), {});
  assert.deepEqual(decode('temperatures', { 12102: 800, 12103: 0x10000 - 400 }), {
    outdoor: 80,
    supply: -40,
  });
  assert.deepEqual(decode('extract', { 12544: 214 }), { extract: 21.4 });
  assert.deepEqual(decode('humidity', { 12136: 101 }), {});
  assert.deepEqual(decode('outputs', { 14001: 45, 14002: 120 }), { fanSupply: 45 });
  assert.deepEqual(decode('setpoint', { 2001: 180 }), { setpoint: 18 });
  assert.deepEqual(decode('setpoint', { 2001: 119 }), {});
  assert.deepEqual(decode('alarms', { 15901: 1, 15902: 0, 15903: 2 }), {
    alarmA: true,
    alarmB: false,
  });
  assert.deepEqual(decode('fans', { 1351: 1 }), { fansRunning: true });
  assert.deepEqual(decode('stopAllowed', { 1353: 0 }), { stopAllowed: false });
});

test('decode: the filter time, low word first, 0 unknown, implausible unknown', () => {
  const seconds = 120 * 86_400 + 5;
  assert.deepEqual(decode('filter', { 7005: seconds & 0xffff, 7006: seconds >>> 16 }), {
    filterDays: 120,
  });
  assert.deepEqual(decode('filter', { 7005: 0, 7006: 0 }), {});
  assert.deepEqual(decode('filter', { 7005: 0xffff, 7006: 0xffff }), {});
  assert.deepEqual(decode('filter', { 7005: 3600, 7006: 0 }), { filterDays: 0 });
});

test('decode: the identity is the ten settings words; a short answer decodes nothing', () => {
  const regs = {};
  for (let i = 0; i < 10; i += 1) regs[1401 + i] = 30 + i;
  assert.equal(decode('identity', regs).identity.length, 40);
  assert.deepEqual(decodeBlock(BLOCK_OF.identity, [1, 2, 3]), {});
});

test('write requests: only 1131 (0, 2, 3, 4) and 1162 (1 to 7), function 6; echo', () => {
  const off = writeRequest(1131, 0);
  assert.deepEqual([...off], [6, 4, 106, 0, 0]);
  assert.deepEqual([...writeRequest(1162, 2)], [6, 4, 137, 0, 2]);
  for (const [register, value] of [
    [1131, 1],
    [1131, 5],
    [1131, -1],
    [1162, 0],
    [1162, 8],
    [1162, true],
    [1161, 1],
    [1353, 1],
    [30101, 3228],
  ]) {
    assert.throws(() => writeRequest(register, value), `${register}=${value}`);
  }
  assert.deepEqual([...ALLOWED_WRITES.keys()].sort(), [1131, 1162]);
  assert.equal(isEcho(off, Buffer.from(off)), true);
  assert.equal(isEcho(off, Buffer.from([6, 4, 106, 0, 1])), false);
});

test('the commands write only allowed values; the stop never enters manual at another level', () => {
  const stop = COMMANDS[FEATURES.STOP].writes();
  assert.deepEqual(stop, [
    { reg: 1131, value: 0 },
    { reg: 1162, value: 2 },
  ]);
  assert.deepEqual(COMMANDS[FEATURES.START].writes(), [{ reg: 1162, value: 1 }]);
  const mode = COMMANDS[FEATURES.MODE];
  for (const choice of Object.keys(mode.values)) {
    for (const fresh of [{ mode: 'auto' }, { mode: 'manual' }]) {
      for (const { reg, value } of mode.writes(choice, fresh)) {
        assert.doesNotThrow(() => writeRequest(reg, value), `${choice}: ${reg}=${value}`);
      }
    }
  }
  assert.deepEqual(mode.writes('manual-low', { mode: 'auto' }), [
    { reg: 1131, value: 2 },
    { reg: 1162, value: 2 },
  ]);
  assert.deepEqual(mode.writes('holiday', { mode: 'auto' }), [{ reg: 1162, value: 7 }]);
});

class Socket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.destroyed = false;
  }
  write(bytes) {
    this.sent.push(Buffer.from(bytes));
  }
  destroy() {
    this.destroyed = true;
  }
}

/** The MBAP answer to the last request sent, with `pdu`. */
function answer(socket, pdu, { tid, uid } = {}) {
  const request = socket.sent.at(-1);
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid ?? request.readUInt16BE(0), 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out[6] = uid ?? request[6];
  Buffer.from(pdu).copy(out, 7);
  return out;
}

test('session: MBAP framing, unit id, answers in chunks', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { unitId: 3 });
  const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
    timeoutMs: 1000,
  });
  const frame = socket.sent[0];
  assert.equal(frame.readUInt16BE(2), 0);
  assert.equal(frame.readUInt16BE(4), 6);
  assert.equal(frame[6], 3);
  const out = answer(socket, [3, 2, 0, 2]);
  socket.emit('data', out.subarray(0, 4));
  socket.emit('data', out.subarray(4));
  assert.deepEqual([...(await pending)], [3, 2, 0, 2]);
  session.close();
});

test('session: hostile answers end it', async () => {
  const cases = [
    ['another transaction', (s) => answer(s, [3, 2, 0, 2], { tid: 0xbeef })],
    [
      'another protocol',
      (s) => {
        const b = answer(s, [3, 2, 0, 2]);
        b.writeUInt16BE(1, 2);
        return b;
      },
    ],
    ['another function', (s) => answer(s, [4, 2, 0, 2])],
    ['bytes beyond the frame', (s) => Buffer.concat([answer(s, [3, 2, 0, 2]), Buffer.from([0])])],
    [
      'a length over 260',
      (s) => {
        const b = answer(s, [3, 2, 0, 2]);
        b.writeUInt16BE(300, 4);
        return b;
      },
    ],
  ];
  for (const [name, build] of cases) {
    const socket = new Socket();
    const session = new ModbusSession(socket, { unitId: 1 });
    const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
      timeoutMs: 1000,
    });
    socket.emit('data', build(socket));
    await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent, name);
    assert.ok(socket.destroyed, name);
  }
  const socket = new Socket();
  const session = new ModbusSession(socket);
  socket.emit('data', Buffer.from([0, 1, 0, 0, 0, 3, 1, 3, 0]));
  assert.ok(socket.destroyed, 'bytes without a request');
  assert.ok(session.dead);
});

test('session: an answer with another unit id is accepted (noted), the transaction still checked', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { unitId: 1 });
  const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
    timeoutMs: 1000,
  });
  socket.emit('data', answer(socket, [3, 2, 0, 7], { uid: 254 }));
  assert.deepEqual([...(await pending)], [3, 2, 0, 7]);
  assert.equal(session.otherUnitId, 254);
  assert.equal(session.dead, undefined);
  session.close();
});

test('session: an exception is REFUSED (sent), the session stays', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket);
  const pending = session.request(writeRequest(1162, 2), { timeoutMs: 1000 });
  socket.emit('data', answer(socket, [0x86, 2]));
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.REFUSED && err.sent);
  assert.equal(session.dead, undefined);
  session.close();
});

test('session: beforeSend and startBy stop a request before any byte', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { now: () => 100 });
  await assert.rejects(
    session.request(Buffer.from([3, 0, 1, 0, 1]), { startBy: 50 }),
    (err) => err.kind === ERROR_KINDS.LATE && !err.sent,
  );
  await assert.rejects(
    session.request(Buffer.from([3, 0, 1, 0, 1]), {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err.beforeSend === true,
  );
  assert.equal(socket.sent.length, 0);
  session.close();
});

test('config: addresses, port, unit id (strict), gateway, interval', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 502 });
  assert.deepEqual(parseAddress('systemair.lan:1502'), { host: 'systemair.lan', port: 1502 });
  for (const bad of [
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    '192.168.1.0',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const ok = normalizeConfig({ host: '192.168.1.80', unit_id: '12' });
  assert.equal(ok.unitId, 12);
  assert.ok(ok.address);
  for (const bad of ['', ' ', '0', '248', '256', 1.5, 'abc', '-1']) {
    const c = normalizeConfig({ host: '192.168.1.80', unit_id: bad });
    assert.equal(c.address, undefined, String(bad));
    assert.equal(c.badUnitId, true, String(bad));
  }
  assert.equal(normalizeConfig({ host: 'x', unit_id: null }).unitId, 1, 'missing: the default');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({}).gateway, 'generic');
  assert.equal(normalizeConfig({ gateway: 'save-connect' }).gateway, 'save-connect');
  assert.equal(normalizeConfig({ gateway: 'toString' }).gateway, 'generic');
  assert.equal(normalizeConfig({ host: 'bad\u0007host' }).invalid, 8, 'only its length');
});
