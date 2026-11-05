// -----------------------------------------------------------------------------
// The unit -> one Gladys device and its states (pure).
//
// `ext:<selector>:systemair:unit`: one device per integration. FROZEN RULE:
// the Modbus map of the SAVE controllers gives no serial number nor MAC
// address, so the device is keyed by the unit of the configuration, never by
// its IP address (a new address keeps the device and its history). The
// feature roles (the last part of their external ids) are published forever:
// never rename them. Every role is always built, so a republished device
// never loses a feature.
//
// No switch, no writable binary, no writable fan: a "turn everything off"
// (Google Home, Alexa, HomeKit, MCP, `switch.*` scenes) never reaches the
// ventilation. The commands are one `text/select` (the mode) and two
// `button/push` features (start, stop); the mode and the start are refused
// unless the configuration allows the commands; the stop is never held back
// by the option (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor, percent on
// humidity-sensor and fan, days on duration. The fan speeds in RPM and the
// air flows are not published (no matching unit in the core).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COMMANDS, FEATURES, MODES, RANGES, READ_MODES } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

export const SERVICE = 'systemair';
export const PLATFORM_ID = 'unit';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = (range = RANGES.temperature) =>
  sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: range[0],
    max: range[1],
  });
const humidity = sensor({
  category: C.HUMIDITY_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.PERCENT,
  min: 0,
  max: 100,
});
const fanLevel = sensor({
  category: C.FAN,
  type: T.FAN.PERCENT,
  unit: U.PERCENT,
  min: 0,
  max: 100,
});
const days = sensor({
  category: C.DURATION,
  type: T.DURATION.INTEGER,
  unit: U.DAYS,
  min: RANGES.filterDays[0],
  max: RANGES.filterDays[1],
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.MODE]: select,
  [FEATURES.CURRENT_MODE]: text,
  [FEATURES.POWER]: binary,
  [FEATURES.FAN_RUNNING]: binary,
  [FEATURES.ALARM_A]: binary,
  [FEATURES.ALARM_B]: binary,
  [FEATURES.ALARM_C]: binary,
  [FEATURES.TEMP_SUPPLY]: temperature(),
  [FEATURES.TEMP_EXTRACT]: temperature(),
  [FEATURES.TEMP_OUTDOOR]: temperature(),
  [FEATURES.SETPOINT]: temperature(RANGES.setpoint),
  [FEATURES.HUMIDITY]: humidity,
  [FEATURES.FAN_SUPPLY]: fanLevel,
  [FEATURES.FAN_EXTRACT]: fanLevel,
  [FEATURES.FILTER]: days,
  [FEATURES.STOP_ALLOWED]: binary,
  [FEATURES.START]: button,
  [FEATURES.STOP]: button,
};

export const ROLES = Object.keys(DEFINITIONS);

/** The value read for each numeric or binary sensor role. */
const VALUE_OF = {
  [FEATURES.POWER]: 'power',
  [FEATURES.FAN_RUNNING]: 'fansRunning',
  [FEATURES.ALARM_A]: 'alarmA',
  [FEATURES.ALARM_B]: 'alarmB',
  [FEATURES.ALARM_C]: 'alarmC',
  [FEATURES.TEMP_SUPPLY]: 'supply',
  [FEATURES.TEMP_EXTRACT]: 'extract',
  [FEATURES.TEMP_OUTDOOR]: 'outdoor',
  [FEATURES.SETPOINT]: 'setpoint',
  [FEATURES.HUMIDITY]: 'humidity',
  [FEATURES.FAN_SUPPLY]: 'fanSupply',
  [FEATURES.FAN_EXTRACT]: 'fanExtract',
  [FEATURES.FILTER]: 'filterDays',
  [FEATURES.STOP_ALLOWED]: 'stopAllowed',
};

export const unitIds = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[1]) ? match[1] : undefined;
}

/** The options of the mode list (labels: plain text, never empty, no space around). */
export function modeOptions(language) {
  return MODES.map((value, index) => ({
    value,
    label: word(MODE_NAMES[value], language).trim(),
    sort_order: index,
  }));
}

/** The Gladys device of the unit. */
export function buildDevice(gladys, { language }) {
  const ids = unitIds(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: 'Systemair SAVE',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.MODE ? { supported_options: modeOptions(language) } : {}),
    })),
    params: [{ name: 'protocol', value: 'Modbus TCP' }],
  };
}

/** Whether a role is a command, and which. */
export const commandOf = (role) => (Object.hasOwn(COMMANDS, role) ? COMMANDS[role] : undefined);

/**
 * The states of the values read this time (a value not read is left out:
 * Gladys keeps its last one, never republished as new). A value outside the
 * bounds of its feature is dropped. Texts are stable English keys, whatever
 * the language (scenes keep working).
 */
export function deviceStates(ids, values) {
  const states = [];
  // The list only shows its options: another mode (cooker hood, stopped…) does not change it.
  if (MODES.includes(values.modeChoice)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.MODE),
      text: values.modeChoice,
    });
  }
  if (READ_MODES.includes(values.mode)) {
    // The manual mode at level off reads "stopped" (the stop of Gladys or of the panel).
    const current = values.mode === 'manual' && values.power === false ? 'stopped' : values.mode;
    states.push({
      device_feature_external_id: ids.feature(FEATURES.CURRENT_MODE),
      text: current,
    });
  }
  for (const [role, key] of Object.entries(VALUE_OF)) {
    let value = values[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    const { min, max } = DEFINITIONS[role];
    if (Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
