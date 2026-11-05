// -----------------------------------------------------------------------------
// The Modbus PDUs of the Systemair SAVE controllers (pure): the read requests
// of the blocks, what their answers mean, and the write requests. Register
// numbers and meanings from Systemair's "Modbus Variable List" (rev. 36), as
// home-assistant-systemair-modbus reads them. Every decoder returns undefined
// when the answer has not the exact size asked or the value is not plausible:
// an unknown value is never a value, and a text is never a 0.
// -----------------------------------------------------------------------------

import {
  FC,
  MANUAL_LEVELS,
  MANUAL_LEVEL_VALUES,
  MODES,
  MODE_REQUESTS,
  RANGES,
  READ_MODES,
  REG,
} from '../constants.js';

/** The only writes ever sent: register -> the values allowed (the list's own values). */
export const ALLOWED_WRITES = new Map([
  [REG.MANUAL_LEVEL, new Set(Object.values(MANUAL_LEVEL_VALUES))],
  [REG.MODE_REQUEST, new Set(Object.values(MODE_REQUESTS))],
]);

const round1 = (value) => Math.round(value * 10) / 10;

/** The read request of `count` registers from `address` (function 3 or 4). */
export function readRequest({ fc, address, count }) {
  if (fc !== FC.READ_HOLDING && fc !== FC.READ_INPUT) throw new RangeError('Not a read function');
  const pdu = Buffer.alloc(5);
  pdu[0] = fc;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words (16-bit registers) of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead({ fc, count }, pdu) {
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== fc) {
    return undefined;
  }
  if (fc !== FC.READ_HOLDING && fc !== FC.READ_INPUT) return undefined;
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(pdu.readUInt16BE(2 + i * 2));
  }
  return words;
}

/** Signed 16-bit (temperatures below zero). */
const int16 = (word) => (word >= 0x8000 ? word - 0x10000 : word);

const within = (value, [min, max]) =>
  Number.isFinite(value) && value >= min && value <= max ? value : undefined;

/** Tenths of a degree, signed; undefined when out of the list's range. */
const tenths = (word, range = RANGES.temperature) =>
  Number.isInteger(word) ? within(round1(int16(word) / 10), range) : undefined;

/** A whole percent 0-100. */
const percent = (word) => (Number.isInteger(word) ? within(word, RANGES.percent) : undefined);

/** A register holding 0 or 1 (anything else is unknown). */
const flag = (word) => (word === 0 ? false : word === 1 ? true : undefined);

/** Register `register` (list number) of a block of words starting at `start`. */
const at = (words, start, register) => words[register - start];

/**
 * The values a block gives (only those plausible). The words are those of
 * `parseRead`, the whole block.
 */
export function decodeBlock(block, data) {
  if (!Array.isArray(data) || data.length !== block.count) return {};
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  const word = (register) => at(data, block.register, register);
  switch (block.key) {
    case 'mode':
      put('mode', READ_MODES[word(1161)]);
      break;
    case 'manual':
      put(
        'manualLevel',
        Object.hasOwn(MANUAL_LEVELS, word(1131)) ? MANUAL_LEVELS[word(1131)] : undefined,
      );
      break;
    case 'fans':
      put('fansRunning', flag(word(1351)));
      break;
    case 'temperatures':
      put('outdoor', tenths(word(12102)));
      put('supply', tenths(word(12103)));
      break;
    case 'extract':
      put('extract', tenths(word(12544)));
      break;
    case 'humidity':
      put('humidity', percent(word(12136)));
      break;
    case 'outputs':
      put('fanSupply', percent(word(14001)));
      put('fanExtract', percent(word(14002)));
      break;
    case 'setpoint':
      put('setpoint', tenths(word(2001), RANGES.setpoint));
      break;
    case 'alarms':
      put('alarmA', flag(word(15901)));
      put('alarmB', flag(word(15902)));
      put('alarmC', flag(word(15903)));
      break;
    case 'filter': {
      // Seconds, lower word first (7005 low, 7006 high). 0 is "unknown" (the
      // reference's choice), never "0 days".
      const seconds = word(7006) * 0x10000 + word(7005);
      if (Number.isInteger(seconds) && seconds > 0) {
        put('filterDays', within(Math.floor(seconds / 86_400), RANGES.filterDays));
      }
      break;
    }
    case 'stopAllowed':
      put('stopAllowed', flag(word(1353)));
      break;
    case 'identity':
      // The fan level settings (1401-1410), as a light fingerprint of the unit.
      if (data.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)) {
        values.identity = data.map((w) => w.toString(16).padStart(4, '0')).join('');
      }
      break;
    default:
      break;
  }
  return values;
}

/**
 * The values that need two blocks of the same read: `power` (false only in
 * the manual mode at level off: the fans stopped from a command) and
 * `modeChoice` (the value of the mode list, when the mode is one of them).
 * Never derived from a value read at another time.
 */
export function derive(values) {
  const { mode, manualLevel } = values;
  const out = { ...values };
  delete out.power;
  delete out.modeChoice;
  if (mode === undefined) return out;
  if (mode !== 'manual') {
    out.power = true;
    if (MODES.includes(mode)) out.modeChoice = mode;
    return out;
  }
  if (manualLevel === undefined) return out;
  out.power = manualLevel !== 'off';
  if (manualLevel !== 'off') out.modeChoice = `manual-${manualLevel}`;
  return out;
}

/**
 * The write request of a single register (function 6): only a register and
 * a value of ALLOWED_WRITES, whatever the caller asks (the last bound before
 * the bytes).
 */
export function writeRequest(register, value) {
  if (!ALLOWED_WRITES.has(register)) {
    throw new RangeError('Not a register Gladys writes');
  }
  if (!Number.isInteger(value) || !ALLOWED_WRITES.get(register).has(value)) {
    throw new RangeError('Not a value Gladys writes');
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.WRITE_REGISTER;
  pdu.writeUInt16BE(register - 1, 1);
  pdu.writeUInt16BE(value, 3);
  return pdu;
}

/** A write is answered by the exact echo of its request. */
export const isEcho = (request, answer) => Buffer.isBuffer(answer) && request.equals(answer);
