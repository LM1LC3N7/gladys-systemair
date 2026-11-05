// -----------------------------------------------------------------------------
// A fake Systemair SAVE unit behind the injected `connect` (no network),
// built from Systemair's "Modbus Variable List" (rev. 36): Modbus TCP framing
// (MBAP), the input registers (function 4) and holding registers (function
// 3) the integration reads, the two registers it writes with their rules
// (1131: 0 only when 1353 allows the manual stop, 1 and > 4 illegal; 1162:
// 1-7, the active mode 1161 follows), answers after a delay (mocked
// timers). `saveConnect`: Systemair's Internet Access Module, every register
// a holding register and function 4 an "illegal function". It counts the
// connections open at once (the integration must never open a second one).
// `frameAnswer()` is the same logic for a real TCP server (gladys-testkit).
// Values made up, never from a real unit.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.80';
export const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);
/** The default unit id (the list: slave address 1 by default). */
export const UNIT_ID = 1;

/** The input registers of the list among those the integration reads. */
export const INPUTS = new Set([1161, 1351, 14001, 14002, 14003, 7005, 7006, 15901, 15902, 15903]);

/** The fan level settings 1401-1410 (the light identity). */
export const SETTINGS = [30, 30, 40, 40, 55, 55, 75, 75, 100, 100];
export const OTHER_SETTINGS = [30, 30, 45, 45, 60, 60, 80, 80, 100, 100];

export const setSettings = (regs, values) =>
  values.forEach((value, i) => regs.set(1401 + i, value));

/** A unit in Auto, manual level normal, fans running, no alarm. Keys: register numbers of the list. */
export function defaultMap() {
  const regs = new Map();
  regs.set(1161, 0); // auto
  regs.set(1131, 3); // manual level normal
  regs.set(1162, 0);
  regs.set(1351, 1); // fans running
  regs.set(1353, 1); // manual stop allowed
  for (let r = 12101; r <= 12108; r += 1) regs.set(r, 0);
  regs.set(12102, 0x10000 - 52); // outdoor -5.2 °C
  regs.set(12103, 185); // supply 18.5 °C
  regs.set(12544, 214); // extract 21.4 °C
  regs.set(12136, 41); // extract humidity 41 %
  regs.set(14001, 45); // supply fan 45 %
  regs.set(14002, 47); // extract fan 47 %
  regs.set(14003, 0);
  regs.set(2001, 180); // setpoint 18.0 °C
  for (const r of [15901, 15902, 15903]) regs.set(r, 0);
  const seconds = 120 * 86_400 + 3600; // 120 days and an hour
  regs.set(7005, seconds & 0xffff);
  regs.set(7006, seconds >>> 16);
  setSettings(regs, SETTINGS);
  return regs;
}

/** The ventilation as the fake unit runs it: stopped only in manual mode at level off. */
function updateFans(regs) {
  regs.set(1351, regs.get(1161) === 1 && regs.get(1131) === 0 ? 0 : 1);
}

/** A write on the fake unit (register number, value): the exception code, or undefined when applied. */
export function applyWrite(regs, register, value, { apply = true } = {}) {
  if (register === 1131) {
    if (![0, 2, 3, 4].includes(value)) return 3;
    if (value === 0 && regs.get(1353) !== 1) return 3;
  } else if (register === 1162) {
    if (value < 1 || value > 7) return 3;
  } else {
    return 2;
  }
  if (!apply) return undefined;
  regs.set(register, value);
  if (register === 1162) regs.set(1161, value - 1);
  updateFans(regs);
  return undefined;
}

/**
 * The answer PDU to a request PDU (function 3, 4 or 6, else illegal
 * function), or undefined when the request is not understood.
 */
export function pduAnswer(regs, pdu, { ignoreWrites = false, saveConnect = false } = {}) {
  const fc = pdu[0];
  const address = pdu.readUInt16BE(1);
  const arg = pdu.readUInt16BE(3);
  if (fc === 3 || fc === 4) {
    if (fc === 4 && saveConnect) return Buffer.from([fc | 0x80, 1]);
    for (let i = 0; i < arg; i += 1) {
      const register = address + 1 + i;
      if (!regs.has(register)) return Buffer.from([fc | 0x80, 2]);
      // On Modbus RTU an input register is read with function 4 only (the list).
      if (!saveConnect && (fc === 4) !== INPUTS.has(register)) return Buffer.from([fc | 0x80, 2]);
    }
    const answer = Buffer.alloc(2 + arg * 2);
    answer[0] = fc;
    answer[1] = arg * 2;
    for (let i = 0; i < arg; i += 1) {
      answer.writeUInt16BE(regs.get(address + 1 + i) ?? 0, 2 + i * 2);
    }
    return answer;
  }
  if (fc === 6) {
    const code = applyWrite(regs, address + 1, arg, { apply: !ignoreWrites });
    if (code !== undefined) return Buffer.from([fc | 0x80, code]);
    return Buffer.from(pdu);
  }
  return Buffer.from([fc | 0x80, 1]);
}

/** One MBAP frame in, its answer frame out (for a real TCP server). */
export function frameAnswer(regs, frame, options) {
  const pdu = frame.subarray(7);
  const answer = pduAnswer(regs, pdu, options);
  const out = Buffer.alloc(7 + answer.length);
  frame.copy(out, 0, 0, 4);
  out.writeUInt16BE(answer.length + 1, 4);
  out[6] = frame[6];
  answer.copy(out, 7);
  return out;
}

class FakeSocket extends EventEmitter {
  constructor(unit) {
    super();
    this.unit = unit;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.unit.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.unit.open.has(this)) {
      this.unit.open.delete(this);
    }
    setImmediate(() => this.emit('close'));
  }

  setNoDelay() {}
}

export function fakeSystemair({ map = defaultMap(), saveConnect = false } = {}) {
  const unit = {
    regs: map,
    saveConnect,
    open: new Set(),
    /** The most connections open at once (must stay 1). */
    maxOpen: 0,
    /** Every request received: { fc, register, count | value, uid, host, at }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** Requests ("fc:register" keys or fc) that never answer, answer an exception, or delays. */
    silent: new Set(),
    exceptions: new Set(),
    exceptionCode: 2,
    delays: {},
    /** Writes acknowledged but not applied (an unconfirmed command). */
    ignoreWrites: false,
    /** Writes applied even after their connection closed. */
    applyClosedWrites: false,
    /** The next connections accepted then closed at once. */
    dropConnections: 0,
    /** Answers split in two chunks, or with a wrong transaction id, or a wrong echo. */
    split: false,
    wrongTransaction: false,
    badEcho: false,
    /** "fc:register" keys whose write echo is wrong (only those). */
    badEchoOn: new Set(),
    /** Hosts connected to. */
    hosts: [],
    /** "fc:register" keys whose request closes the connection, unanswered; writes that do so. */
    closeOn: new Set(),
    closeOnWrite: 0,
    /** Called with the request when a write arrives (before it is applied). */
    onWrite: undefined,
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const register = pdu.readUInt16BE(1) + 1;
      const arg = pdu.readUInt16BE(3);
      const write = fc === 6;
      unit.log.push(
        write
          ? { fc, register, value: arg, uid, host: socket.host, at: Date.now() }
          : { fc, register, count: arg, uid, host: socket.host, at: Date.now() },
      );
      const key = `${fc}:${register}`;
      if (write) unit.onWrite?.({ register, value: arg });
      if (unit.closeOn.has(key) || (write && unit.closeOnWrite > 0)) {
        if (write) unit.closeOnWrite -= 1;
        setTimeout(() => socket.destroy(), unit.delay);
        return;
      }
      if (unit.silent.has(key) || unit.silent.has(fc)) return;
      setTimeout(() => {
        if (socket.destroyed) {
          // A write already in the unit is applied even when its connection is gone.
          if (write && unit.applyClosedWrites && !unit.ignoreWrites) {
            applyWrite(unit.regs, register, arg);
          }
          return;
        }
        let answer;
        if (unit.exceptions.has(key) || unit.exceptions.has(fc)) {
          answer = Buffer.from([fc | 0x80, unit.exceptionCode]);
        } else {
          answer = pduAnswer(unit.regs, pdu, {
            ignoreWrites: unit.ignoreWrites,
            saveConnect: unit.saveConnect,
          });
          if (write && (unit.badEcho || unit.badEchoOn.has(key)) && answer[0] === 6) answer[4] ^= 1;
        }
        const out = Buffer.alloc(7 + answer.length);
        out.writeUInt16BE(unit.wrongTransaction ? (tid + 1) & 0xffff : tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(answer.length + 1, 4);
        out[6] = uid;
        answer.copy(out, 7);
        if (unit.split) {
          socket.emit('data', out.subarray(0, 3));
          socket.emit('data', out.subarray(3));
        } else {
          socket.emit('data', out);
        }
      }, unit.delays[key] ?? unit.delay);
    },
    connect(host) {
      const socket = new FakeSocket(unit);
      socket.host = host;
      unit.hosts.push(host);
      unit.connections += 1;
      setTimeout(() => {
        if (socket.destroyed) return;
        if (unit.down) {
          unit.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        if (unit.dropConnections > 0) {
          unit.dropConnections -= 1;
          socket.emit('connect');
          setImmediate(() => !socket.destroyed && socket.emit('close'));
          return;
        }
        unit.open.add(socket);
        unit.maxOpen = Math.max(unit.maxOpen, unit.open.size);
        socket.emit('connect');
      }, unit.connectDelay);
      return socket;
    },
    writes: () =>
      unit.log
        .filter((r) => r.fc === 6)
        .map(({ fc, register, value }) => ({ fc, register, value })),
    reads: () => unit.log.filter((r) => r.fc !== 6).length,
    /** Running in auto (as a panel would set it). */
    run(mode = 0, level = 3) {
      unit.regs.set(1161, mode);
      unit.regs.set(1131, level);
      updateFans(unit.regs);
    },
    /** Stopped: manual mode, level off (as the panel would set it). */
    halt() {
      unit.regs.set(1161, 1);
      unit.regs.set(1131, 0);
      updateFans(unit.regs);
    },
  };
  unit.connectFn = (host) => unit.connect(host);
  return unit;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
