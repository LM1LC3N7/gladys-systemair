// -----------------------------------------------------------------------------
// Systemair constants: the Modbus map of the SAVE controllers (VTR, VSR, VSC…),
// feature roles, limits and timings.
//
// The registers are those Systemair publishes in its "Modbus Variable List"
// (release 2021-03-01, revision 36, main board software 2.0), as
// home-assistant-systemair-modbus (MIT) reads and writes them: register number
// N of the list is protocol address N - 1. The list gives input registers
// (function 4) and holding registers (function 3) on Modbus RTU, and holding
// registers only on Modbus TCP through Systemair's own Internet Access Module
// (SAVE Connect): the `gateway` option picks the function of the input
// registers. Only these requests are ever sent:
//   - read 1161 (active user mode), 1351 (fans running), 14001-14003 (fan
//     outputs, sum alarm), 7005-7006 (remaining filter time), 15901-15903
//     (alarm types A, B, C): input registers;
//   - read 1131 (manual fan level), 1353 (manual stop allowed), 2001 (supply
//     air setpoint), 12101-12108 (temperatures), 12136 (extract humidity),
//     12544 (extract temperature), 1401-1410 (fan level settings, the light
//     identity): holding registers;
//   - write single register 1131 (manual fan level: 0 off, 2 low, 3 normal,
//     4 high) and 1162 (user mode request: 1 auto … 7 holiday).
// Nothing else is ever written: no settings, no clock, no alarm reset, no
// filter reset, no factory reset, no password.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  READ_INPUT: 0x04,
  WRITE_REGISTER: 0x06,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/** Register numbers of Systemair's list (protocol address = number - 1). */
export const REG = {
  MANUAL_LEVEL: 1131,
  MODE: 1161,
  MODE_REQUEST: 1162,
};

/**
 * The blocks read at each poll, in this order: the unit's state first, the
 * secondary ones last (a secondary block that fails never stops the values
 * read before it). `register`: the first register number of the list;
 * `address`: its protocol address (register - 1); `input`: an input register
 * of the list (function 4, or 3 through SAVE Connect).
 */
export const BLOCKS = [
  { key: 'mode', register: 1161, count: 1, input: true },
  { key: 'manual', register: 1131, count: 1, input: false },
  { key: 'fans', register: 1351, count: 1, input: true },
  { key: 'temperatures', register: 12101, count: 8, input: false },
  { key: 'extract', register: 12544, count: 1, input: false },
  { key: 'humidity', register: 12136, count: 1, input: false },
  { key: 'outputs', register: 14001, count: 3, input: true },
  { key: 'setpoint', register: 2001, count: 1, input: false },
  { key: 'alarms', register: 15901, count: 3, input: true },
  { key: 'filter', register: 7005, count: 2, input: true },
  { key: 'stopAllowed', register: 1353, count: 1, input: false },
  { key: 'identity', register: 1401, count: 10, input: false },
].map((b) => ({ ...b, address: b.register - 1 }));

export const BLOCK_OF = Object.fromEntries(BLOCKS.map((b) => [b.key, b]));

/** The blocks of the unit's state (mode, manual level): never skipped. */
export const STATE_BLOCKS = new Set(['mode', 'manual']);

/** The blocks a command reads just before it writes, and after (its read back). */
export const FRESH_BLOCKS = ['mode', 'manual', 'identity'];
export const BACK_BLOCKS = ['mode', 'manual'];

/** Register 1161 as read (index = value): the active user mode, stable keys. */
export const READ_MODES = [
  'auto',
  'manual',
  'crowded',
  'refresh',
  'fireplace',
  'away',
  'holiday',
  'cooker-hood',
  'vacuum-cleaner',
  'cdi1',
  'cdi2',
  'cdi3',
  'pressure-guard',
];

/** Register 1131: the fan level of the manual mode (1 is not a value of the list). */
export const MANUAL_LEVELS = { 0: 'off', 2: 'low', 3: 'normal', 4: 'high' };
export const MANUAL_LEVEL_VALUES = { off: 0, low: 2, normal: 3, high: 4 };

/** Register 1162: the user mode request ("New desired user mode as requested by HMI"). */
export const MODE_REQUESTS = {
  auto: 1,
  manual: 2,
  crowded: 3,
  refresh: 4,
  fireplace: 5,
  away: 6,
  holiday: 7,
};

/**
 * The choices of the mode list Gladys may write (never "off": that is the
 * stop button). `manual-*` writes the manual level (1131) then, when the unit
 * is not in manual mode yet, the manual mode (1162 = 2).
 */
export const MODES = [
  'auto',
  'manual-low',
  'manual-normal',
  'manual-high',
  'crowded',
  'refresh',
  'fireplace',
  'away',
  'holiday',
];

/**
 * Modbus exception codes that mean the request was not applied (illegal
 * function, address, value). Any other code (4 device failure, 5 acknowledge,
 * 6 busy…) may come from a write the unit applies anyway: "sent, without
 * confirmation".
 */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** The exception "illegal function": an input register read with function 4 through SAVE Connect. */
export const ILLEGAL_FUNCTION = 1;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  CURRENT_MODE: 'current-mode',
  POWER: 'power',
  FAN_RUNNING: 'fans-running',
  ALARM_A: 'alarm-a',
  ALARM_B: 'alarm-b',
  ALARM_C: 'alarm-c',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXTRACT: 'temperature-extract',
  TEMP_OUTDOOR: 'temperature-outdoor',
  SETPOINT: 'supply-setpoint',
  HUMIDITY: 'humidity-extract',
  FAN_SUPPLY: 'fan-supply-level',
  FAN_EXTRACT: 'fan-extract-level',
  FILTER: 'filter-remaining',
  STOP_ALLOWED: 'manual-stop-allowed',
  START: 'start',
  STOP: 'stop',
};

/**
 * The commands, by feature role. `writes(value, fresh)`: the registers
 * written, in this order; `read`: the value read back that confirms it.
 * The non-protective commands need the option; `needsRunning`: refused on a
 * unit stopped (manual mode, level off: a mode would start it) and while a
 * stop sent from Gladys is kept; `starts`: the start, which alone lifts a
 * kept stop. `protective`: never held back (stopping the fans).
 */
export const COMMANDS = {
  [FEATURES.MODE]: {
    read: 'modeChoice',
    values: Object.fromEntries(MODES.map((m) => [m, m])),
    needsRunning: true,
    writes(choice, fresh) {
      if (choice.startsWith('manual-')) {
        const level = { reg: REG.MANUAL_LEVEL, value: MANUAL_LEVEL_VALUES[choice.slice(7)] };
        // The level first: in another mode it only sets the level of the manual mode.
        return fresh?.mode === 'manual'
          ? [level]
          : [level, { reg: REG.MODE_REQUEST, value: MODE_REQUESTS.manual }];
      }
      return [{ reg: REG.MODE_REQUEST, value: MODE_REQUESTS[choice] }];
    },
  },
  [FEATURES.START]: {
    read: 'power',
    button: true,
    expected: true,
    starts: true,
    writes: () => [{ reg: REG.MODE_REQUEST, value: MODE_REQUESTS.auto }],
  },
  [FEATURES.STOP]: {
    read: 'power',
    button: true,
    expected: false,
    protective: true,
    // The level first: the unit never enters the manual mode at a higher level.
    writes: () => [
      { reg: REG.MANUAL_LEVEL, value: MANUAL_LEVEL_VALUES.off },
      { reg: REG.MODE_REQUEST, value: MODE_REQUESTS.manual },
    ],
  },
};

/** The value of a button press (Gladys sends 1). */
export const PRESSED = 1;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds (the reference warns that the touch panel suffers from fast polls). */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

/** The Modbus unit id of the configuration (the list: slave address 1 to 247, 1 by default). */
export const UNIT_ID = {
  min: 1,
  max: 247,
  default: 1,
};

/**
 * The gateways: `generic` (an RS485 gateway such as the Elfin EW11: input
 * registers with function 4, falling back to 3 when the unit answers
 * "illegal function"; up to 10 registers a request) and `save-connect`
 * (Systemair's Internet Access Module: every register as a holding register,
 * as the list says for Modbus TCP; 2 registers a request and a longer pause,
 * the "safe mode" of the reference).
 */
export const GATEWAYS = {
  generic: { maxCount: 10, pace: 50, inputFc: FC.READ_INPUT },
  'save-connect': { maxCount: 2, pace: 100, inputFc: FC.READ_HOLDING },
};
export const DEFAULT_GATEWAY = 'generic';

/** Plausible values (anything else is not a measure). */
export const RANGES = {
  /** The list: -400..800 tenths of a degree. */
  temperature: [-40, 80],
  /** The list: REG_TC_SP 120..300 tenths of a degree. */
  setpoint: [12, 30],
  percent: [0, 100],
  /** The filter period is 3 to 15 months: more than 500 days left is not plausible. */
  filterDays: [0, 500],
};

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** A measure block that times out this many reads in a row is skipped. */
  blockTimeouts: 3,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** A measure block skipped after repeated timeouts or refusals is tried again this often. */
  blockRetry: HOUR,
  /** A stop reaffirmed by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** `getConfig()` failed in `connected`: tried again after 5 s, 15 s, 30 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the connection, the fresh read
   * and the first write must be done by 3.5 s after the click, or the command
   * is refused unsent; the read back that confirms it is awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Connecting for a command: 1.5 s at most. */
  commandConnectMax: 1_500,
  /** One fresh read of a command: 1 s at most; 0.2 s at least left to send after it. */
  commandReadMax: 1_000,
  commandMinRead: 200,
  commandMinSend: 200,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A read waits this long at most for /data to keep its time before it starts (never blocking). */
  attemptSaveWait: 500,
  /** A poll due while a command or a stop holds the line is tried again this much later. */
  busyRetry: SECOND,
  /** A stop pressed while one runs with less than this left of its window starts a new one after it. */
  stopJoinMin: SECOND,
  /** The stop waits this long at most for /data to keep it before its first byte (never blocking). */
  stopSaveWait: 150,
  /** A stop not confirmed is reaffirmed by the next reads, three times at most (sends that left). */
  stopReasserts: 3,
  /** /data: one read or one write of the state file waits this long at most. */
  storeTimeout: 2 * SECOND,
};
