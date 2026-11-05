// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the time of the last read of the unit (written at most once a
// minute, BEFORE the read), so a restart never reads the unit sooner than the
// interval; the light identity learnt for the unit (a fingerprint of its fan
// level settings); the address of the last configuration; a kept stop (the
// address it was sent to, whether it may not have landed yet, whether the
// unit was seen off since, the resends that left). No secret (the Modbus
// interface has none), no personal data. The file is readable by the
// container user only (0600), bounded and repaired when read back.
//
// Every wait on /data is bounded (2 s): a file that never answers (a FIFO, a
// stuck disk) is an error, never a wait without end, and only a regular file
// is read. `load()` tells "no file" (null) from "a file that cannot be read"
// (it throws): an unreadable /data is never taken for an empty one (no new
// identity is learnt over it, no kept stop is forgotten by a later write).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { DEFAULT_PORT, TIMINGS, UNIT_ID } from './constants.js';

export const STATE_FILE = '/data/systemair-state.json';
const MAX_SIZE = 4 * 1024;

/** `promise`, or a rejection after `ms` (the operation may still end later). */
function bounded(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readRegular(path) {
  // O_NONBLOCK: a FIFO never blocks the open; O_NOFOLLOW: never a link.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
    }
    if (info.size > MAX_SIZE) {
      throw Object.assign(new Error('too large'), { code: 'EFBIG' });
    }
    const buffer = Buffer.alloc(MAX_SIZE + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SIZE + 1, 0);
    if (bytesRead > MAX_SIZE) {
      throw Object.assign(new Error('too large'), { code: 'EFBIG' });
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

export function fileStore(path = STATE_FILE, { timeoutMs = TIMINGS.storeTimeout } = {}) {
  // One write at a time; a write that times out never renames over a later one.
  let chain = Promise.resolve();
  let seq = 0;
  return {
    async load() {
      let text;
      try {
        text = await bounded(readRegular(path), timeoutMs, 'state file read');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        if (err?.code === 'EFBIG') throw new Error('state file too large', { cause: err });
        throw new Error(`state file unreadable (${err?.code ?? err?.message ?? 'error'})`, {
          cause: err,
        });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const id = (seq += 1);
      const write = chain.then(async () => {
        if (text.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.${id}.tmp`;
        let stale = false;
        const work = (async () => {
          // O_EXCL | O_NOFOLLOW: a new regular file, never a link or a FIFO left there.
          const handle = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await handle.writeFile(text);
          } finally {
            await handle.close().catch(() => {});
          }
          if (stale) {
            await unlink(temporary).catch(() => {});
            return;
          }
          await rename(temporary, path);
        })();
        try {
          await bounded(work, timeoutMs, 'state file write');
        } catch (err) {
          stale = true;
          work.catch(() => {});
          await unlink(temporary).catch(() => {});
          throw err;
        }
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/**
 * For the tests: the same JSON round trip as the file; `failLoad` /
 * `failSave` simulate a broken /data, `hang` a /data that never answers.
 */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    hang: false,
    async load() {
      if (this.hang) return new Promise(() => {});
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : undefined;

const HOST = /^[a-z0-9.-]{1,253}$/;
const FINGERPRINT = /^[0-9a-f]{40}$/;

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null (a time in the
 *   future counts as now: never a longer wait than the interval);
 * - `identity`: `{ unit, fingerprint }` learnt for the unit `unit` (address
 *   and Modbus unit id), or null;
 * - `target`: `{ unit, host, port, unitId }`, the unit of the last
 *   configuration read (a stop pressed before the configuration is read
 *   again goes there), or null;
 * - `stopGuard`: `{ unit, host, port, unitId, pending, seenOff, onReads,
 *   reasserts, sticky }`, a kept stop, or null. It holds no date: it is never
 *   lifted by the time, only by a start pressed in Gladys (with the option) or
 *   by the unit read running twice in a row after it was seen stopped. An
 *   unreadable count is 0.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const identity = data.identity && typeof data.identity === 'object' ? data.identity : {};
  const guard = data.stopGuard && typeof data.stopGuard === 'object' ? data.stopGuard : {};
  const unit = shortText(identity.unit, 280);
  const fingerprint =
    typeof identity.fingerprint === 'string' && FINGERPRINT.test(identity.fingerprint)
      ? identity.fingerprint
      : undefined;
  const guardTarget = normalizeTarget(guard);
  const count = (value, max) => (Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0);
  return {
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    identity: unit && fingerprint ? { unit, fingerprint } : null,
    target: normalizeTarget(data.target) ?? null,
    stopGuard: guardTarget
      ? {
          ...guardTarget,
          // Anything but a clear false: the stop may not have landed (sent again at start).
          pending: guard.pending !== false,
          seenOff: guard.seenOff === true,
          onReads: count(guard.onReads, 2),
          reasserts: count(guard.reasserts, TIMINGS.stopReasserts),
          sticky: guard.sticky === true,
        }
      : null,
  };
}

/** Where a unit is (`{ unit, host, port, unitId }`), repaired, else undefined. */
export function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const unit = shortText(raw.unit, 280);
  const host = typeof raw.host === 'string' && HOST.test(raw.host) ? raw.host : undefined;
  const port =
    Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : DEFAULT_PORT;
  const unitId =
    Number.isInteger(raw.unitId) && raw.unitId >= UNIT_ID.min && raw.unitId <= UNIT_ID.max
      ? raw.unitId
      : undefined;
  return unit && host && unitId !== undefined ? { unit, host, port, unitId } : undefined;
}
