// -----------------------------------------------------------------------------
// The integration: the unit typed in the configuration (the IP address of its
// Modbus TCP gateway and the Modbus unit id), one read of its registers every
// poll interval over one Modbus TCP connection, the Gladys device and its
// states, the transport badge, the "Test the connection" button, and the
// commands. index.js only wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"), one request at a time on it:
// a poll is one session of a dozen small requests (paced, the touch panel
// suffers from fast polls), closed after; a command takes the line from a
// poll (the poll is dropped, nothing of it published); "Stop the ventilation"
// takes it from anything.
//
// Reads follow the rules learnt on the previous modules:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written at most once a minute, BEFORE the read);
//     a reconnection during a read joins it;
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status; a read begun before a command left is not
//     applied (order by the time requests leave, never by the time answers
//     come); a value not read this time is never republished as new;
//   - a secondary block that fails (an exception, a timeout, a closed
//     connection, a wrong answer) never costs the values read before it.
//
// Commands (mode, start):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before each write (nothing runs in between);
//   - decided on a fresh read in the same session (mode, manual level, the
//     fan level settings that identify the unit), never on the state in
//     memory; refused when a value cannot be read, when the settings differ
//     from those learnt, when /data cannot be read; the mode is refused while
//     the ventilation is stopped (manual mode, level off: it would start it)
//     and while a stop sent from Gladys is kept; not written when already so
//     (unless a guard says a previous command may not show yet);
//   - first write within 3.5 s of the click or refused unsent; confirmed
//     only by the echo of each write and a read back equal to the value asked,
//     by 4.3 s; a read back equal to the state before is "not applied yet";
//     else "sent, without confirmation" and spaced reads; a Modbus exception
//     1-3 is "refused by the unit", any other code "sent, without
//     confirmation"; never retried; one at a time;
//   - the ack never waits for a publication to Gladys.
//
// "Stop the ventilation" protects (1131 = 0 "off", then 1162 = 2 "manual"):
// never held back by the option, another command, a read in progress or
// stuck, a failed read, a backoff, the identity, /data or a configuration not
// read yet; tried again until 3.5 s after the press (idempotent writes);
// cancels a command not written yet. It is then KEPT (in /data, with its
// address): never lifted by the time, only by "Start the ventilation" pressed
// with the option, or by the ventilation read running twice in a row after it
// was seen stopped (started on its panel). While kept, a poll that reads the
// ventilation running before it was seen stopped (or after a start that may
// still land, within its 90 s) sends it again: three sends the unit answered
// at most (a closed connection, a timeout or a gateway held by another master
// is not counted). A level off refused for certain (exception 1-3) is not kept. A stop that may not have landed when the container
// stopped is sent again at start from /data, before the configuration is read.
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  BACK_BLOCKS,
  BLOCKS,
  BLOCK_OF,
  COMMANDS,
  FC,
  FEATURES,
  FRESH_BLOCKS,
  GATEWAYS,
  ILLEGAL_FUNCTION,
  LIMITS,
  NOT_APPLIED_EXCEPTIONS,
  PRESSED,
  REG,
  SECOND,
  STATE_BLOCKS,
  TIMINGS,
} from './constants.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import {
  decodeBlock,
  derive,
  isEcho,
  parseRead,
  readRequest,
  writeRequest,
} from './modbus/protocol.js';
import { buildDevice, commandOf, deviceStates, parseFeatureId, unitIds } from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time). */
  values: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

const STOP_PLAN = {
  role: FEATURES.STOP,
  command: COMMANDS[FEATURES.STOP],
  expected: COMMANDS[FEATURES.STOP].expected,
};

/** The values a command reads back (the state blocks), derived together. */
const sleep = (timers, ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

export class SystemairApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'systemair' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: nothing learnt nor written over it. */
    this.memoryUnreadable = false;
    this.memoryLoaded = false;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The time of the last read sent to the unit (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands getting ready to take the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The command in flight (one at a time), and the stop in flight. */
    this.inFlight = undefined;
    this.protecting = undefined;
    /** The end of the window of the stop in flight (a press near its end starts a new one). */
    this.protectUntil = -Infinity;
    /** Counts the stops: a command that sees it change before its write gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last start left (and was not refused by the unit). */
    this.lastStartAt = -Infinity;
    /** A start or a mode written and not confirmed yet: a stop after it is sticky. */
    this.startOpen = false;
    /** The fingerprint read when it differs from the one kept for this unit (commands refused). */
    this.mismatch = undefined;
    /** The function of the input registers (4, or 3 once the gateway refused 4, or SAVE Connect). */
    this.inputFc = FC.READ_INPUT;
    /** Value key -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** The kept stop (see the header), or undefined. */
    this.stopGuard = undefined;
    /** Block key -> timeouts in a row while the unit answered the others. */
    this.timeouts = new Map();
    /** Measure block key -> when it is tried again (skipped after repeated timeouts or refusals). */
    this.skipped = new Map();
    /** The pending resend of a stop. */
    this.reassertTimer = undefined;
    /** `getConfig()` failed in `connected`: the retry timer and the failures in a row. */
    this.configTimer = undefined;
    this.configFailures = 0;
    this.connectSeq = 0;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  // --- /data -------------------------------------------------------------------

  /** Reads /data once (again after a failure): an unreadable file is never taken for an empty one. */
  async loadMemory() {
    let raw;
    try {
      raw = await this.bounded(this.store.load(), 'read');
    } catch (err) {
      if (!this.memoryUnreadable) {
        this.logger.warn(
          `Systemair: /data unreadable (${err.message}); nothing is written over it`,
        );
      }
      this.memoryUnreadable = true;
      return;
    }
    const loaded = normalizeMemory(raw, this.now());
    this.memoryUnreadable = false;
    this.memoryLoaded = true;
    // What runs now wins over what was kept (a stop sent since the file was read).
    this.memory = {
      lastAttemptAt: this.memory.lastAttemptAt ?? loaded.lastAttemptAt,
      identity: this.memory.identity ?? loaded.identity,
      target: this.memory.target ?? loaded.target,
      stopGuard: this.guardRecord() ?? loaded.stopGuard,
    };
    if (!this.stopGuard && loaded.stopGuard) {
      this.stopGuard = {
        ...loaded.stopGuard,
        sentAt: this.mono(),
        stickyUntil: this.mono(),
        restored: true,
      };
      this.logger.info('Systemair: a stop kept in /data is still kept');
    }
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      throw new Error('/data unreadable');
    }
    await this.bounded(this.store.save(this.memory), 'write');
  }

  /**
   * A /data operation, never awaited without end: after its bound it is an
   * error (the read: /data unreadable; the write: a failed save), whatever the
   * store does (a FIFO, a stuck disk).
   */
  bounded(promise, what) {
    let timer;
    const limit = new Promise((_resolve, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new Error(`/data ${what} timed out`)),
        TIMINGS.storeTimeout + 500,
      );
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(timer));
  }

  /** A background save: logged on failure, never awaited by a protective path. */
  saveSoon() {
    const saving = this.saveMemory();
    saving.catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
    return saving;
  }

  /** The kept stop as /data keeps it (no date: it never ends by the time). */
  guardRecord(guard = this.stopGuard) {
    if (!guard) return null;
    const { unit, host, port, unitId, pending, seenOff, onReads, reasserts, sticky } = guard;
    return { unit, host, port, unitId, pending, seenOff, onReads, reasserts, sticky };
  }

  /** Keeps the stop guard in /data (or clears it). */
  persistStopGuard() {
    const next = this.guardRecord();
    if (JSON.stringify(next) === JSON.stringify(this.memory.stopGuard ?? null)) {
      return Promise.resolve();
    }
    this.memory.stopGuard = next;
    return this.saveSoon();
  }

  /**
   * Container start, before Gladys is reached: a stop that may not have
   * landed when the container stopped is sent again now, from /data (its
   * address), without the configuration nor a first read.
   */
  async boot() {
    await this.loadMemory();
    // The last configuration kept in /data is the current one until Gladys says otherwise.
    if (this.memory.target) this.adoptGuard(this.memory.target);
    const guard = this.stopGuard;
    if (guard?.pending) {
      this.logger.warn('Systemair: a stop may not have landed before the restart, sent again');
      this.protect(STOP_PLAN, this.mono(), this.guardTarget(guard)).catch((err) =>
        this.logger.warn(`Systemair: stop sent again at start: ${err.message}`),
      );
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    if (generation !== this.generation) {
      return;
    }
    if (!this.memoryLoaded) {
      await this.loadMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    this.unit = freshUnit();
    this.mismatch = undefined;
    this.inputFc = GATEWAYS[this.config.gateway].inputFc;
    this.timeouts.clear();
    this.skipped.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    const target = this.configTarget();
    if (target) this.adoptGuard(target);
    if (target && JSON.stringify(target) !== JSON.stringify(this.memory.target)) {
      // Where a stop goes before the configuration is read again (after a restart).
      this.memory.target = target;
      if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
    }
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The unit of the configuration, as kept in /data: its address and Modbus unit id. */
  unitKey() {
    return this.config.address ? `${addressKey(this.config.address)}#${this.config.unitId}` : '';
  }

  /** Where the configuration points. */
  configTarget() {
    if (!this.config.address) return undefined;
    return {
      unit: this.unitKey(),
      host: this.config.address.host,
      port: this.config.address.port,
      unitId: this.config.unitId,
    };
  }

  guardTarget(guard) {
    return { unit: guard.unit, host: guard.host, port: guard.port, unitId: guard.unitId };
  }

  /**
   * A kept stop of another unit than `target` (the address changed since):
   * one that may not have landed yet now goes to `target` (the device is the
   * same; the old address may have been a typo pointing at another Modbus
   * device, never written again); one already seen applied is forgotten.
   */
  adoptGuard(target) {
    const guard = this.stopGuard;
    if (!guard || guard.unit === target.unit) return;
    if (guard.pending) {
      this.stopGuard = { ...guard, ...target, seenOff: false, onReads: 0 };
      this.logger.warn(
        'Systemair: a stop not confirmed for the previous address goes to the new one',
      );
    } else {
      this.stopGuard = undefined;
      this.logger.info('Systemair: the stop kept for the previous address is forgotten');
    }
    if (!this.memoryUnreadable && this.memoryLoaded) this.persistStopGuard().catch(() => {});
  }

  /** The kept stop, when it belongs to the unit of the configuration. */
  ownGuard() {
    return this.stopGuard && this.stopGuard.unit === this.unitKey() ? this.stopGuard : undefined;
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    // One reading of each clock: the wall time kept, as a time of the monotonic clock.
    const now = this.now();
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (now - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - now));
  }

  /**
   * A new configuration or a restart: the reads and commands of this run end.
   * A stop in flight goes on (bounded by its own deadline), unless the
   * container shuts down.
   */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    if (shutdown || this.active?.kind !== 'protect') {
      this.active?.abort('stopped');
    }
    this.publisher.stop();
    // Command guards belong to this address and this run only (the kept stop stays).
    this.guards.clear();
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
    if (shutdown && this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** The container stops: everything ends, /data keeps the last state. */
  async shutdown() {
    this.stop({ shutdown: true });
    if (!this.memoryUnreadable && this.memoryLoaded) {
      this.memory.stopGuard = this.guardRecord();
      await this.saveMemory().catch(() => {});
    }
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, with the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `Systemair: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(age(wait)));
      if (seq !== this.connectSeq) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('Systemair: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq) return;
    this.configFailures = 0;
    await this.connected(raw);
  }

  /**
   * The configuration read. The first time, start; after a reconnection,
   * resend what Gladys keeps in memory only (status, Discovery list, badge)
   * and the last states, without reading the unit.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or unit id restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid ||
      next.unitId !== this.config.unitId ||
      next.gateway !== this.config.gateway
    );
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      // Before the first configuration was read: this one starts.
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Systemair commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection to `target`; the line is held
   * until it ends. `retryUntil`: a refused connection is tried again every
   * 250 ms until then (the unit may free its place a moment after our own
   * close); nothing is sent before the connection, so this never repeats a
   * command.
   */
  async useLine(kind, timeoutMs, fn, { retryUntil, target = this.configTarget() } = {}) {
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      if (!target) {
        throw new ModbusError(ERROR_KINDS.UNREACHABLE, 'no address');
      }
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: target.host,
          port: target.port,
          unitId: target.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      const other = record.session?.otherUnitId;
      if (other !== undefined && other !== this.otherUnitIdLogged) {
        this.otherUnitIdLogged = other;
        this.logger.info(
          `Systemair: the unit answers with Modbus unit id ${other} (accepted; ${target?.unitId} asked)`,
        );
      }
      record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds, { protective = false } = {}) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      // The abort destroys its socket (or its connection in progress) at once:
      // the stop never waits for what that session still awaits (a slow /data).
      if (!protective) await current.done;
    }
  }

  /**
   * One block read in `session`: its values (only those plausible). A block
   * longer than the gateway takes is read in several requests (`pace`
   * between them); an input register read with function 4 that the gateway
   * refuses as an "illegal function" is read again with function 3, and so
   * are all the input registers afterwards (Systemair's list: holding
   * registers only on Modbus TCP).
   */
  async readBlock(session, key, { pace = 0, ...options } = {}) {
    const block = BLOCK_OF[key];
    const { maxCount } = GATEWAYS[this.config.gateway];
    const words = [];
    for (let offset = 0; offset < block.count; offset += maxCount) {
      if (offset > 0 && pace > 0) {
        await sleep(this.timers, pace);
      }
      const count = Math.min(maxCount, block.count - offset);
      words.push(...(await this.readWords(session, block, offset, count, options)));
    }
    return decodeBlock(block, words);
  }

  async readWords(session, block, offset, count, options) {
    for (;;) {
      const fc = block.input ? this.inputFc : FC.READ_HOLDING;
      const request = { fc, address: block.address + offset, count };
      let pdu;
      try {
        pdu = await session.request(readRequest(request), options);
      } catch (err) {
        if (
          block.input &&
          fc === FC.READ_INPUT &&
          err.kind === ERROR_KINDS.REFUSED &&
          err.code === ILLEGAL_FUNCTION
        ) {
          this.inputFc = FC.READ_HOLDING;
          this.logger.info(
            'Systemair: the gateway refuses function 4, input registers read as holding registers',
          );
          continue;
        }
        throw err;
      }
      const data = parseRead(request, pdu);
      if (data === undefined) {
        // An answer of the wrong size: the session is not trusted any more.
        session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
        throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
      }
      return data;
    }
  }

  /** Several blocks in `session`, derived together (power, mode choice). */
  async readBlocks(session, keys, budget, deadline) {
    const values = {};
    for (const [index, key] of keys.entries()) {
      if (index > 0) await this.paceWithin(deadline);
      Object.assign(
        values,
        await this.readBlock(session, key, { timeoutMs: budget(), pace: this.paceFor(deadline) }),
      );
    }
    return derive(values);
  }

  /**
   * The pause of the gateway between two requests of a command or a stop,
   * when its deadline leaves room for it (else none: the deadline first).
   */
  paceFor(deadline) {
    const { pace } = GATEWAYS[this.config.gateway];
    return deadline !== undefined && deadline - this.mono() > pace + 500 ? pace : 0;
  }

  async paceWithin(deadline) {
    const pace = this.paceFor(deadline);
    if (pace > 0) await sleep(this.timers, pace);
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval after the last one began; never sooner. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    const now = this.mono();
    // Start to start: the period is the interval, whatever a read lasted.
    let wait = delay ?? (u.online === false ? u.wait : this.due - now);
    // Never sooner than the interval after the last read; capped at the interval
    // (a clock jump never stops the reads).
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - now), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Systemair refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (a container stopped during the read keeps it). At
   * most one write a minute; a failed write never stops the read.
   */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      if (!this.memoryUnreadable) {
        // Waited for a moment only: a /data that never answers never stops the reads.
        let timer;
        await Promise.race([
          this.saveMemory().catch((err) =>
            this.logger.warn(`Saving the state to /data failed: ${err.message}`),
          ),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, TIMINGS.attemptSaveWait);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command or a stop holds the line: the poll is tried again a second later.
      this.schedule(TIMINGS.busyRetry);
      return;
    }
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // Taken while /data kept the time of this read: never two connections.
      this.schedule(TIMINGS.busyRetry);
      return;
    }
    let values;
    let failure;
    try {
      values = await this.useLine('read', TIMINGS.connectTimeout, (session) =>
        this.readAll(session),
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      // A command took the line: nothing of this read is applied.
      this.logger.debug('Systemair: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('Systemair: read begun before a command, not applied');
    } else {
      this.applyRead(values);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * Every block, one after the other. A block that times out while the unit
   * answered the ones before ends the read (the session is gone): what was
   * read is kept. A block refused by the unit (Modbus exception) leaves its
   * values unknown this time. A state block (on/off, mode, status) is never
   * skipped; a measure block that times out three reads in a row, or is
   * refused, is skipped and tried again every hour (one log line when it is
   * skipped). A state block that timed out is read last at the next read.
   */
  async readAll(session) {
    return derive(await this.readAllBlocks(session));
  }

  async readAllBlocks(session) {
    const { pace } = GATEWAYS[this.config.gateway];
    const values = {};
    let first = true;
    let answered = 0;
    const read = new Set();
    const stateRead = () => [...STATE_BLOCKS].every((key) => read.has(key));
    const late = (b) => STATE_BLOCKS.has(b.key) && this.timeouts.has(b.key);
    const order = [...BLOCKS.filter((b) => !late(b)), ...BLOCKS.filter(late)];
    for (const block of order) {
      const skippedUntil = this.skipped.get(block.key);
      if (skippedUntil !== undefined && this.mono() < skippedUntil) {
        continue;
      }
      if (!first) {
        // A pause between requests: the gateway and the touch panel share the bus.
        await sleep(this.timers, pace);
      }
      first = false;
      let decoded;
      try {
        decoded = await this.readBlock(session, block.key, {
          timeoutMs: TIMINGS.requestTimeout,
          pace,
        });
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          answered += 1;
          if (STATE_BLOCKS.has(block.key)) {
            this.logger.warn(`Systemair: block ${block.key} refused (${errorReason(err)})`);
          } else {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Systemair: block ${block.key} refused (${errorReason(err)}), tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          }
          continue;
        }
        if (
          !STATE_BLOCKS.has(block.key) &&
          stateRead() &&
          [ERROR_KINDS.CLOSED, ERROR_KINDS.PROTOCOL].includes(err.kind)
        ) {
          // A secondary block that ends the session (closed, wrong answer) never
          // costs the values read before it: skipped, tried again every hour; the
          // next read starts afresh on a new connection.
          if (skippedUntil === undefined) {
            this.logger.warn(
              `Systemair: block ${block.key} failed (${errorReason(err)}), tried again every hour`,
            );
          }
          this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          return values;
        }
        if (err.kind === ERROR_KINDS.TIMEOUT && answered > 0) {
          const count = (this.timeouts.get(block.key) ?? 0) + 1;
          this.timeouts.set(block.key, count);
          if (STATE_BLOCKS.has(block.key)) {
            this.logger.warn(`Systemair: block ${block.key} did not answer`);
          } else if (count >= LIMITS.blockTimeouts) {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Systemair: block ${block.key} never answers, tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          } else {
            this.logger.warn(`Systemair: block ${block.key} did not answer`);
          }
          return values;
        }
        throw err;
      }
      answered += 1;
      this.timeouts.delete(block.key);
      this.skipped.delete(block.key);
      read.add(block.key);
      Object.assign(values, decoded);
    }
    return values;
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead(values) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.values = values;
    this.checkIdentity(values);
    this.observe(values);
  }

  /**
   * The light identity of the unit: a fingerprint of its fan level settings
   * (1401-1410; the Modbus map has no serial number nor MAC address), learnt
   * at the first read and kept in /data for this address and unit id. Another
   * one read means another unit may answer at the address (or the settings
   * were changed): the commands (except the stop) are refused until the test
   * button accepts it. An unreadable value is never "another unit"; nothing
   * is learnt over an unreadable /data.
   */
  checkIdentity(values) {
    const seen = values.identity;
    if (seen === undefined || this.memoryUnreadable) {
      return;
    }
    const kept = this.memory.identity;
    if (!kept || kept.unit !== this.unitKey()) {
      this.memory.identity = { unit: this.unitKey(), fingerprint: seen };
      this.mismatch = undefined;
      this.saveSoon().catch(() => {});
      return;
    }
    if (kept.fingerprint === seen) {
      this.mismatch = undefined;
      return;
    }
    if (this.mismatch !== seen) {
      this.logger.warn(
        'Systemair: the fan level settings changed; commands refused until the test button accepts the unit',
      );
    }
    this.mismatch = seen;
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`Systemair: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    if (!c.address) {
      if (c.invalid) return T.invalid(c.invalid);
      return c.badUnitId ? T.badUnitId : T.noHost;
    }
    let text;
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      text = [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
        ? T.unreachable(addressKey(c.address), wait)
        : T.failing(u.error ?? 'error', wait);
    } else if (u.online === true && this.mismatch !== undefined) {
      text = T.otherUnit;
    } else if (u.online === undefined) {
      text =
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting;
    } else {
      text = T.connected(T.summary(u.values ?? {}));
    }
    if (u.online === true && u.values?.stopAllowed === false) {
      text = join(text, T.stopNotAllowed);
    }
    if (this.inputFc === FC.READ_HOLDING && c.gateway === 'generic') {
      text = join(text, T.fallback);
    }
    if (this.stopRefused?.unit === this.unitKey()) {
      text = join(text, T.stopRefused(this.stopRefused.code));
    }
    const guard = this.ownGuard();
    if (guard) {
      // Exactly where the stop is: not confirmed yet, given up after three sends, or kept.
      const exhausted = !guard.seenOff && guard.reasserts >= TIMINGS.stopReasserts;
      text = join(text, exhausted ? T.stopNotApplied : guard.seenOff ? T.stopKept : T.stopPending);
    }
    if (this.memoryUnreadable) {
      text = join(text, T.dataUnreadable);
    }
    return both(text.en.replace(/ {2,}/g, ' '), text.fr.replace(/ {2,}/g, ' '));
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = unitIds(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The device, once the unit answered (every feature, always). */
  async publishDevices() {
    if (this.unit.online !== true) {
      return;
    }
    const devices = [buildDevice(this.gladys, { language: this.config.language })];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      unitIds(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueStates(created) {
    if (this.unit.online === true && this.unit.values) {
      this.queueValues(this.unit.values, created);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    if (this.mismatch !== undefined) {
      // Accepts exactly the settings shown by the last read, without a read.
      const accepted = this.mismatch;
      const previous = this.memory.identity;
      this.memory.identity = { unit: this.unitKey(), fingerprint: accepted };
      try {
        await this.saveMemory();
      } catch {
        this.memory.identity = previous;
        return join(this.status(), T.dataUnreadable);
      }
      this.mismatch = undefined;
      this.logger.info('Systemair: unit accepted with its current fan level settings');
      await this.updateStatus();
      return T.accepted;
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    const now = this.mono();
    if (now < this.due) {
      const waited = T.waiting(age(this.due - now));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(now - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    let choice;
    let expected;
    if (command.button) {
      // Strictly 1: null, '', true, 0 or "on" never press a button.
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badButton);
      }
      expected = command.expected;
    } else {
      // Strictly one of the values of the select: never trimmed, re-cased nor a number.
      if (typeof value !== 'string' || !Object.hasOwn(command.values, value)) {
        throw this.refusal(ERRORS.badValue);
      }
      choice = value;
      expected = value;
    }
    const plan = { role, command, choice, expected };
    if (command.protective) {
      // The address of the configuration, else (configuration not read yet) the
      // one the kept stop was sent to, else the last one kept in /data.
      const target =
        this.configTarget() ??
        (this.stopGuard ? this.guardTarget(this.stopGuard) : undefined) ??
        this.memory.target ??
        undefined;
      if (!target) {
        throw this.refusal(ERRORS.noHost);
      }
      return this.protect(plan, received, target);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.protecting) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    const promise = this.command(plan, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /**
   * The values a command read or confirmed (both state blocks of one
   * session): in memory and to Gladys in the background.
   */
  noteValues(values, { fromCommand = false } = {}) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    this.unit.values = derive({ ...this.unit.values, ...values });
    this.observe(values, { fromCommand });
    this.queueValues(values);
    // Shown in the background: the ack never waits for Gladys.
    this.flush().catch(() => {});
  }

  async command(plan, received) {
    const generation = this.generation;
    const seq = this.protectSeq;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The checks before each write, on the latest configuration.
    const check = () => {
      if (!this.config.allowCommands) {
        throw this.refusal(ERRORS.disabled);
      }
      if (generation !== this.generation || !this.config.address) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (seq !== this.protectSeq) {
        throw this.refusal(ERRORS.protectMeanwhile);
      }
    };
    const state = { written: false, seq };
    this.reserved += 1;
    try {
      if (this.memoryUnreadable) {
        throw this.refusal(ERRORS.dataUnreadable);
      }
      if (plan.command.needsRunning && this.ownGuard()) {
        // A mode would start a ventilation stopped from Gladys: only "Start" lifts the stop.
        throw this.refusal(ERRORS.stopKept);
      }
      await this.takeLine(['read']);
      if (this.active) {
        throw this.refusal(this.active.kind === 'protect' ? ERRORS.protectMeanwhile : ERRORS.busy);
      }
      check();
      const connectBudget = Math.min(
        TIMINGS.commandConnectMax,
        sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead - this.mono(),
      );
      if (connectBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      return await this.useLine('command', connectBudget, (session) =>
        this.commandSession(session, plan, { check, sendBy, answerBy, state }),
      );
    } catch (err) {
      throw this.commandError(err, plan, state);
    } finally {
      this.reserved -= 1;
      if (state.liftSaved && !state.written && this.stopGuard) {
        // The start never left: /data keeps the stop again.
        this.memory.stopGuard = undefined;
        this.persistStopGuard().catch(() => {});
      }
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, plan, state) {
    if (!state.written && (err instanceof Refusal || err?.beforeSend)) {
      return err;
    }
    const reason = errorReason(err);
    const what = `${plan.role}${plan.choice ? ` ${plan.choice}` : ''}`;
    // Only a write says whether the command may have left (a read never does).
    if (!state.written) {
      this.logger.warn(`Systemair: command NOT sent (${what}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          state.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      // A Modbus exception to the first write: the unit did not apply it.
      this.logger.warn(`Systemair: command refused by the unit (${what}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the unit: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    const key = plan.command.read;
    this.guards.set(key, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
    this.logger.warn(`Systemair: command sent, NOT confirmed (${plan.role}): ${reason}`);
    if (state.backEqualsBefore) {
      return this.refusal(ERRORS.notYetApplied);
    }
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  async commandSession(session, plan, { check, sendBy, answerBy, state }) {
    const { command } = plan;
    // The state just before acting, read now in this session, never the one in memory.
    const read = {};
    for (const key of FRESH_BLOCKS) {
      const budget = Math.min(
        TIMINGS.commandReadMax,
        sendBy - TIMINGS.commandMinSend - this.mono(),
      );
      if (budget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (key !== FRESH_BLOCKS[0]) await this.paceWithin(sendBy);
      try {
        Object.assign(
          read,
          await this.readBlock(session, key, { timeoutMs: budget, pace: this.paceFor(sendBy) }),
        );
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) {
          throw err;
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
    }
    const fresh = derive(read);
    if (fresh.identity === undefined) {
      throw this.refusal(ERRORS.noIdentity);
    }
    if (fresh.mode === undefined) {
      throw this.refusal(ERRORS.unknownMode);
    }
    if (fresh.power === undefined) {
      throw this.refusal(ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)));
    }
    check();
    // The light identity read in the same session: another unit refuses the command.
    this.checkIdentity(fresh);
    if (this.mismatch !== undefined) {
      throw this.refusal(ERRORS.otherUnit);
    }
    if (!this.memory.identity || this.memory.identity.unit !== this.unitKey()) {
      // Not learnt (a read of /data failed meanwhile): incomplete identity.
      throw this.refusal(ERRORS.noIdentity);
    }
    // A fresh read of a command never sends a stop again.
    this.noteValues(fresh, { fromCommand: true });
    if (command.needsRunning) {
      // A ventilation stopped (manual, level off) is never started by a mode.
      if (fresh.power !== true) {
        throw this.refusal(ERRORS.unitOff);
      }
      if (this.ownGuard()) {
        throw this.refusal(ERRORS.stopKept);
      }
    }
    if (command.starts && this.ownGuard()) {
      // The start lifts the kept stop: /data must forget it BEFORE the first byte
      // (a restart would else stop the ventilation again), or nothing is sent.
      this.memory.stopGuard = null;
      try {
        await this.saveMemory();
      } catch {
        this.memory.stopGuard = this.guardRecord();
        throw this.refusal(ERRORS.dataUnreadable);
      }
      state.liftSaved = true;
      check();
    }
    state.from = fresh[command.read];
    if (state.from === plan.expected && !this.guardActive(command.read)) {
      // Already so: nothing sent (a start still lifts the kept stop: the user's latest wish).
      if (command.starts && this.ownGuard()) {
        this.liftStopGuard('start pressed, ventilation already running');
      }
      this.logger.info(`Systemair: ${plan.role} already so, nothing sent`);
      return;
    }
    const writes = command.writes(plan.choice, fresh);
    this.logger.info(
      `Systemair: ${plan.role}${plan.choice ? ` ${plan.choice}` : ''} (${writes.map((w) => `${w.reg}=${w.value}`).join(', ')})`,
    );
    const previousStart = this.lastStartAt;
    const previousOpen = this.startOpen;
    const previousGuard = this.stopGuard;
    for (const [index, { reg, value }] of writes.entries()) {
      const first = index === 0;
      // The pause before each write (the first one too, after the fresh read).
      await this.paceWithin(first ? sendBy : answerBy);
      const request = writeRequest(reg, value);
      let echo;
      try {
        echo = await session.request(request, {
          timeoutMs: Math.max(100, answerBy - this.mono()),
          // The first write leaves by 3.5 s or not at all; the next ones before the answer is due.
          startBy: first ? sendBy : answerBy - 100,
          beforeSend: () => {
            // The option, the configuration and a stop, checked right before each write.
            check();
            this.lastSentAt = this.mono();
            if (!first) return;
            state.written = true;
            // The latest wish: a kept stop is lifted right before the synchronous write of a start.
            this.startOpen = true;
            if (command.starts) {
              this.lastStartAt = this.mono();
              if (this.stopGuard && this.stopGuard.unit === this.unitKey()) {
                this.stopGuard = undefined;
              }
            }
          },
        });
      } catch (err) {
        if (
          !first &&
          (err instanceof Refusal || err?.beforeSend || err.kind === ERROR_KINDS.LATE)
        ) {
          // The first write left: whatever stops the next one, it is "sent, without confirmation".
          throw new ModbusError(ERROR_KINDS.ABORTED, 'next write not sent', { sent: true });
        }
        if (first && err.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(err.code)) {
          // Refused by the unit (illegal function, address or value): not applied,
          // and never counts as the latest start. Other exception codes (device
          // failure, acknowledge, busy) may be applied: "sent, without confirmation".
          state.refused = true;
          this.lastStartAt = previousStart;
          this.startOpen = previousOpen;
          if (command.starts && previousGuard && !this.stopGuard) {
            // The start was not applied: the ventilation stays stopped, and the stop stays kept.
            this.stopGuard = previousGuard;
            this.persistStopGuard().catch(() => {});
          }
        }
        throw err;
      }
      if (!isEcho(request, echo)) {
        session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
        throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
      }
    }
    // Confirmed only by the value read back equal to the value asked.
    if (answerBy - this.mono() < 50) {
      throw new ModbusError(ERROR_KINDS.TIMEOUT, 'no time left to read back', { sent: true });
    }
    await this.paceWithin(answerBy);
    const back = await this.readBlocks(
      session,
      BACK_BLOCKS,
      () => Math.max(50, answerBy - this.mono()),
      answerBy,
    );
    const got = back[command.read];
    if (got !== plan.expected) {
      if (got !== undefined) {
        state.backEqualsBefore = got === state.from;
        this.noteValues(back);
      }
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'read back differs', { sent: true });
    }
    this.guards.delete(command.read);
    this.startOpen = false;
    this.noteValues(back);
    this.logger.info(`Systemair: ${plan.role} confirmed by the unit`);
  }

  // --- The stop (protective) -----------------------------------------------

  /** A second press while one runs joins it. */
  async protect(plan, received, target = this.configTarget(), { reassert = false } = {}) {
    if (this.protecting) {
      if (this.protectUntil - this.mono() >= TIMINGS.stopJoinMin) {
        return this.protecting;
      }
      // The stop running has almost no time left: a new one follows it.
      await this.protecting.catch(() => {});
      return this.protect(plan, this.mono(), target, { reassert });
    }
    this.protectUntil = received + TIMINGS.commandSendBy;
    const promise = this.sendStop(plan, received, target, { reassert });
    this.protecting = promise;
    try {
      return await promise;
    } finally {
      if (this.protecting === promise) {
        this.protecting = undefined;
      }
    }
  }

  /**
   * Never held back: takes the line from anything, two writes (1131 = 0,
   * then 1162 = 2), without a fresh read; a refused connection, a closed one,
   * a timeout or a wrong answer is tried again every 250 ms until 3.5 s after
   * the click (both writes are idempotent); the echo of each write and the
   * mode and level read back confirm it. Answered by 4.3 s; still running
   * then, it goes on, bounded by its connection (3 s) and its answers (2 s
   * each), and the answer says whether it was written yet. Kept afterwards
   * (see the header). A level refused by the unit (manual stop not allowed)
   * never sends the manual mode: the unit never enters it at another level.
   */
  async sendStop(plan, received, target, { reassert = false } = {}) {
    // A command not written yet gives way (checked right before its write).
    this.protectSeq += 1;
    this.stopRefused = undefined;
    // A start or a mode that may have left before this stop and is not
    // confirmed may still be applied after it: the stop is then sticky (sent
    // again when the ventilation reads running, even after it was seen stopped).
    const previous = this.stopGuard?.unit === target.unit ? this.stopGuard : undefined;
    // A press decides afresh (never carried from an older stop); a resend keeps
    // the flag of the stop it repeats while its window lasts.
    const carried = reassert && previous?.sticky && this.mono() < (previous.stickyUntil ?? 0);
    const sticky =
      this.startOpen ||
      (this.guardActive('power') && this.guards.get('power').expected === true) ||
      this.guardActive('modeChoice') ||
      Boolean(carried);
    // Kept before the first byte; /data is given a short moment, never awaited longer.
    this.stopGuard = {
      ...target,
      sentAt: this.mono(),
      pending: true,
      seenOff: false,
      onReads: 0,
      // A press starts the count again; a resend by the reads keeps it (and
      // adds one only once its bytes leave).
      reasserts: reassert ? (previous?.reasserts ?? 0) : 0,
      sticky,
      // A start or mode not confirmed can land within its guard (90 s) at most.
      stickyUntil: carried ? previous.stickyUntil : this.mono() + TIMINGS.guard,
    };
    const saved = this.persistStopGuard().catch(() => {});
    let saveTimer;
    await Promise.race([
      saved,
      new Promise((resolve) => {
        saveTimer = this.timers.setTimeout(resolve, TIMINGS.stopSaveWait);
      }),
    ]);
    this.timers.clearTimeout(saveTimer);
    const guard = this.stopGuard;
    const state = { written: false, sentAt: undefined, counted: false };
    const retryUntil = received + TIMINGS.commandSendBy;
    // Only a resend the unit answered (the echo of its first write, or a Modbus
    // exception) counts as one of the three: a connection closed, a timeout or a
    // wrong answer never does (another master may hold the gateway).
    const count = () => {
      if (reassert && !state.counted && this.stopGuard === guard) {
        state.counted = true;
        guard.reasserts += 1;
        this.persistStopGuard().catch(() => {});
      }
    };
    const attempt = (session) =>
      (async () => {
        for (const [index, { reg, value }] of plan.command.writes().entries()) {
          if (index > 0) {
            await this.paceWithin(retryUntil);
          }
          const request = writeRequest(reg, value);
          let echo;
          try {
            echo = await session.request(request, {
              timeoutMs: Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono())),
              beforeSend: () => {
                this.lastSentAt = this.mono();
                // The stop now carries a start not confirmed (its sticky flag).
                this.startOpen = false;
                if (state.written) return;
                state.written = true;
                state.sentAt = this.mono();
              },
            });
          } catch (err) {
            if (err instanceof ModbusError && err.kind === ERROR_KINDS.REFUSED) {
              err.register = reg;
              state.answered = true;
              if (index === 0) count();
            }
            throw err;
          }
          if (!isEcho(request, echo)) {
            session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
            throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', {
              sent: true,
            });
          }
          state.answered = true;
          if (index === 0) count();
        }
        await this.paceWithin(retryUntil);
        return this.readBlocks(session, BACK_BLOCKS, () => TIMINGS.requestTimeout, retryUntil);
      })();
    const AGAIN = [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL];
    this.reserved += 1;
    const sending = (async () => {
      try {
        await this.takeLine(['read', 'command', 'protect'], { protective: true });
        for (;;) {
          try {
            return await this.useLine('protect', TIMINGS.connectTimeout, attempt, {
              retryUntil,
              target,
            });
          } catch (err) {
            const again =
              AGAIN.includes(err?.kind) && this.mono() + TIMINGS.connectRetry < retryUntil;
            if (!again) {
              throw err;
            }
            await sleep(this.timers, TIMINGS.connectRetry);
          }
        }
      } finally {
        this.reserved -= 1;
      }
    })();
    this.logger.info(
      `Systemair: stop${sticky ? ' (after a start or mode not confirmed)' : ''}${reassert ? ' (sent again)' : ''}`,
    );
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (back) => resolve({ back }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    // The guard may have been lifted meanwhile (a start pressed after this stop).
    const own = this.stopGuard === guard;
    const ownUnit = target.unit === this.unitKey();
    if (outcome.back?.power === plan.expected) {
      if (own) {
        guard.pending = false;
        guard.seenOff = true;
        guard.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      this.guards.delete('power');
      this.closeStart();
      if (sticky) {
        this.followUp();
      }
      if (ownUnit) {
        this.noteValues(outcome.back);
      }
      this.logger.info('Systemair: stop confirmed by the unit');
      return;
    }
    // Not confirmed: kept pending, the next reads send it again.
    this.followUp();
    if (outcome.late) {
      sending
        .then((back) => {
          if (back?.power === plan.expected && this.stopGuard === guard) {
            guard.pending = false;
            guard.seenOff = true;
            this.persistStopGuard().catch(() => {});
          }
        })
        .catch((err) => {
          if (this.refusedLevel(err)) this.stopRefusedByUnit(guard, err);
          this.logger.warn(`Systemair: stop failed after the ack (${errorReason(err)})`);
        });
      if (!state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(
        ERRORS.stopUnconfirmed(
          word(both('no answer yet', 'pas encore de réponse'), this.config.language),
        ),
      );
    }
    if (outcome.err) {
      const reason = errorReason(outcome.err);
      this.logger.warn(`Systemair: stop failed (${reason})`);
      if (!state.written) {
        throw this.refusal(ERRORS.stopNotSent(reason));
      }
      if (this.refusedLevel(outcome.err)) {
        this.stopRefusedByUnit(guard, outcome.err);
        throw this.refusal(outcome.err.code === 3 ? ERRORS.stopNotAllowed : ERRORS.refused(reason));
      }
      if (
        outcome.err.kind === ERROR_KINDS.REFUSED &&
        NOT_APPLIED_EXCEPTIONS.has(outcome.err.code)
      ) {
        throw this.refusal(ERRORS.stopModeRefused(reason));
      }
      throw this.refusal(
        state.answered ? ERRORS.stopUnconfirmed(reason) : ERRORS.stopNoAnswer(reason),
      );
    }
    if (outcome.back !== undefined && ownUnit) {
      this.noteValues(outcome.back);
    }
    throw this.refusal(
      ERRORS.stopUnconfirmed(
        word(both('still running', 'toujours en marche'), this.config.language),
      ),
    );
  }

  /** A refusal of the level off (exception 1-3 on 1131): certain, nothing applied. */
  refusedLevel(err) {
    return (
      err?.kind === ERROR_KINDS.REFUSED &&
      NOT_APPLIED_EXCEPTIONS.has(err.code) &&
      err.register === REG.MANUAL_LEVEL
    );
  }

  /**
   * The unit refused the level off for certain (manual stop not allowed): the
   * stop is neither pending nor resent, and never blocks the mode; the status
   * says so until a stop is pressed again.
   */
  stopRefusedByUnit(guard, err) {
    this.stopRefused = { unit: guard.unit, code: err.code };
    if (this.stopGuard === guard) {
      this.stopGuard = undefined;
      this.persistStopGuard().catch(() => {});
    }
    this.logger.warn(`Systemair: the unit refused the stop (exception ${err.code}); not kept`);
  }

  /** The kept stop ends (a start pressed, or the unit started elsewhere). */
  liftStopGuard(reason) {
    if (!this.stopGuard) return;
    this.logger.info(`Systemair: kept stop lifted (${reason})`);
    this.stopGuard = undefined;
    this.persistStopGuard().catch(() => {});
  }

  // --- Guards --------------------------------------------------------------------

  /** No command guard left: no start or mode may still land (a stop is no longer sticky for it). */
  closeStart() {
    if (!this.guards.has('power') && !this.guards.has('modeChoice') && !this.inFlight) {
      this.startOpen = false;
    }
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      this.closeStart();
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards: a command guard lifts when the value moved
   * from the start state to the one asked (never on an unknown value). The
   * kept stop, on a poll of its own unit only (never a command's fresh read):
   * off read -> seen off; on read before it was seen off (or after a start
   * or mode that may still land) -> sent again, three times at most; on read
   * twice in a row after it was seen off -> started elsewhere, lifted. An
   * unknown value changes nothing but the count of "on" reads in a row.
   */
  observe(values, { fromCommand = false } = {}) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
        this.closeStart();
      }
    }
    const stop = this.ownGuard();
    if (!stop || fromCommand) {
      return;
    }
    if (this.lastStartAt > stop.sentAt) {
      this.liftStopGuard('start pressed after the stop');
      return;
    }
    if (values.power === false) {
      if (stop.sticky && this.mono() >= stop.stickyUntil) {
        // Seen applied after the window of the start that could land: no longer sticky.
        stop.sticky = false;
        this.persistStopGuard().catch(() => {});
      }
      if (!stop.seenOff || stop.onReads !== 0 || stop.pending) {
        stop.seenOff = true;
        stop.pending = false;
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      return;
    }
    if (values.power !== true) {
      if (stop.onReads !== 0) {
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      return;
    }
    if (stop.seenOff) {
      stop.onReads += 1;
      if (stop.onReads >= 2) {
        this.liftStopGuard('unit read on twice in a row after the stop, started elsewhere');
        return;
      }
      this.persistStopGuard().catch(() => {});
      if (!stop.sticky) {
        return;
      }
    }
    if (this.protecting || this.reassertTimer || stop.reasserts >= TIMINGS.stopReasserts) {
      return;
    }
    // Counted only when the unit answers its first write (sendStop): anything else is never a try.
    this.logger.warn('Systemair: the ventilation still runs after a stop, stop sent again');
    // Not awaited, and a second after the read closed the line.
    const generation = this.generation;
    this.reassertTimer = this.timers.setTimeout(() => {
      this.reassertTimer = undefined;
      if (generation !== this.generation || this.ownGuard() !== stop) {
        return;
      }
      this.protect(STOP_PLAN, this.mono(), this.guardTarget(stop), { reassert: true }).catch(
        (err) => this.logger.warn(`Systemair: stop sent again: ${err.message}`),
      );
    }, TIMINGS.reassertDelay);
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Systemair refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
