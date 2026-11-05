// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. No secret: the
// Modbus TCP interface of the Systemair SAVE controllers has no password.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_GATEWAY, DEFAULT_PORT, GATEWAYS, POLL_INTERVAL, UNIT_ID } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  unit_id: UNIT_ID.default,
  gateway: DEFAULT_GATEWAY,
  allow_commands: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address a unit can have: never 0.x, multicast (224-239), reserved/broadcast (240-255) nor x.x.x.0 / x.x.x.255. */
function unicastIPv4(host) {
  const parts = host.split('.').map(Number);
  return parts[0] !== 0 && parts[0] < 224 && parts[3] !== 0 && parts[3] !== 255;
}

/**
 * The address of the unit typed by the user: an IPv4 address or a host name,
 * with an optional port (502 otherwise).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unicastIPv4(host) ? { host, port } : undefined;
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A whole number typed or sent: a number, or digits only ('' and ' ' are not 0). */
function strictInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = typeof c.host === 'string' ? c.host.trim() : '';
  const address = parseAddress(typed);
  const interval = strictInteger(c.poll_interval);
  const unitId = strictInteger(c.unit_id);
  const unitIdValid = unitId !== undefined && unitId >= UNIT_ID.min && unitId <= UNIT_ID.max;
  return {
    /** Undefined when the address or the unit id is invalid: nothing is read nor sent. */
    address: unitIdValid ? address : undefined,
    /**
     * The length of what was typed, when it is not a valid address: the text
     * itself is never shown again (a key may have been pasted there by mistake).
     */
    invalid: typed !== '' && !address ? typed.length : undefined,
    /** The Modbus unit id; an invalid one is refused, never replaced by a guess. */
    unitId: unitIdValid ? unitId : undefined,
    badUnitId: !unitIdValid,
    /** The gateway (generic RS485 gateway, or Systemair's SAVE Connect): anything unknown is generic. */
    gateway:
      typeof c.gateway === 'string' && Object.hasOwn(GATEWAYS, c.gateway)
        ? c.gateway
        : DEFAULT_GATEWAY,
    allowCommands: strictTrue(c.allow_commands),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, interval)),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
