# TODO — Systemair SAVE v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 20) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-11-05): the unit by gateway address,
      Modbus unit id and gateway type, about twelve paced reads every
      interval over one connection (never sooner, even after a restart), one
      device, mode select and start button behind `allow_commands` (off),
      "Stop the ventilation" never held back and kept until a start, test
      button, docs en/fr, cover. Tested against a fake unit only (and a real
      TCP server of gladys-testkit at x20).
- [x] **Review r1 fixes** (2026-11-05): a resend counts only when the unit
      answered its first write (B1); `startOpen` ends with its command guard,
      `sticky` lasts the 90 s window and is never carried by a press (I1);
      the stop never waits for a command session it destroyed, a start stuck
      on /data included (I2); a level off refused for certain is not kept
      (m1); a pending stop follows a new address, a confirmed one of the old
      address is forgotten (m2); stop answers and guide (m3); commands and
      stops paced on SAVE Connect (m4); tests for M23 and M25 (m5). Tests
      `r1 …` in `test/app.test.js`.
- [x] **Review r2 fixes** (2026-11-05): the resend of a sticky stop is decided
      on its 90 s window (`sticky && mono < stickyUntil`), which ends by the
      time whatever the read shows; /data never brings `sticky` back (I1b);
      tests for the protectSeq check before a mode write (M27) and for the
      level applied / manual mode refused branch (N07). Tests `r2 …`.
- [ ] **Milestone 2 — real unit**: run against a real SAVE unit, through an
      EW11 and through SAVE Connect (see "To check").
- [ ] **Milestone 3 — more**: accessory sensors (room, CO2, RH on UI1-UI5:
      their "not connected" value must be known first), ECO, free cooling,
      remaining time of the timed modes (1111-1112), IAQ level, heat
      recovery and heater outputs, filter reset and alarm reset as buttons
      behind the option, the CD4 controller (experimental in the reference).

## To check on a real unit

- How SAVE Connect answers function 4 (an "illegal function" exception, as
  the reference says, or a closed connection) and how many registers a
  request it takes (the reference's safe mode reads two).
- What 1161 reads right after a mode request (immediately, or after a delay:
  then "not applied yet" is the normal first answer).
- That 1131 = 0 is refused with exception 3 when 1353 = 0 (assumed from the
  list's note), and that 1131 = 0 in the manual mode stops both fans.
- Whether the week schedule writes the user mode (then the "read running
  twice in a row" rule would lift a kept stop at the next scheduled start,
  which is the intent).
- The values of 12103, 12544 and 12136 when a sensor is missing.
- Whether the fan level settings (1401-1410) are stable enough as a
  fingerprint (they change only when the installer or the user changes the
  levels on the panel).
- Whether the gateway accepts a second Modbus client (Home Assistant and
  Gladys at once), and how the touch panel copes with a poll every 60 s.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-systemair:0.1.0`);
  the first patch release gives 0.1.1. The manifest test checks the semver
  shape and that the four agree, never a pinned value.
- **Reference**: home-assistant-systemair-modbus 1.3.0 (MIT; LICENSE read:
  "Copyright (c) 2026 Håvard Bertelsen"), latest release of 2026-09-12,
  cloned read-only in `~/code/ref/lot20/systemair-modbus` (commit dbfe5e0).
  Registers checked against Systemair's "Modbus Variable List" (release
  2021-03-01, revision 36, main board software 2.0; the same revision is
  still the one on shop.systemair.com in 2024). Credited in
  `THIRD_PARTY_NOTICES.md` with the full license text, copied in the image.
  **Not ported**: CD4, setpoints, durations, free cooling, ECO, filter reset,
  air flow estimates, the 10 s post-connect delay, the soft stop at the low
  level when the stop is not allowed (refused here, and said so).
- **SDK** 0.16.0 (latest on npm, 2026-11-05).
- **Sibling module**: gladys-komfovent (structure, the line, Modbus client,
  guards, publisher, store), with the lessons of lots 17 to 20 added: /data
  bounded (2.5 s) and regular files only, the resends of a kept stop counted
  only when they leave, the status saying where the stop is.
- **Identity (FROZEN RULE)**: no serial number nor MAC in the map, so the
  device is `systemair:unit`, one per integration, never the IP address. A
  light fingerprint: the fan level settings 1401-1410, learnt at the first
  read and kept in `/data` with the unit key (address and unit id). Other
  settings read (poll or a command's fresh read): the status says so, the
  mode and the start are refused; "Test the connection" accepts exactly the
  settings of the last read. An unreadable block is never "another unit".
  Two units with the same settings are not told apart (documented).
- **Gateways**: `generic` (function 4 for input registers, function 3 from
  the first "illegal function" on, 10 registers a request at most, 50 ms
  between requests) and `save-connect` (function 3 for all, as the list
  says for Modbus TCP; 2 registers a request, 100 ms between requests).
- **Power**: "off" only in the manual mode at level off (the stop of Gladys
  or of the panel); away/holiday/CDI levels set to off on the unit read "on"
  (the fans running flag shows them).
- **Commands**: mode (1162 = 1..7; manual levels write 1131 then 1162 = 2
  when not in manual yet) and start (1162 = 1, auto) behind the option; the
  start alone lifts a kept stop, and /data must have forgotten it BEFORE the
  first byte (save failed or slow: refused, nothing sent). Refused on other
  settings, on /data unreadable; the mode also on a stopped ventilation and
  while a stop is kept. Alarms do not refuse a command (the unit's own
  safety logic keeps the fans off on a fire or frost alarm).
- **The stop (protective)**: 1131 = 0 then 1162 = 2. Never held back (see
  docs). The guard is written to /data before its first byte, waiting 150
  ms at most. Kept with its address: `pending`, `seenOff`, `onReads`,
  `reasserts` (sends the unit answered, 3 at most; an unreadable count is 0),
  `sticky`. No date in /data: never lifted by the time.
- **getConfig() in `connected`**: retried after 5 s, 15 s, 30 s, then every
  minute, without end, with a status; a new `connected` resets it.
- **Polling period**: start to start, never sooner than the interval;
  failures back off 30 s, 1, 2, 5 min.
- **Units**: °C; humidity %; fan outputs on `fan/percent` (read only); the
  filter on `duration/integer` in days (0 seconds left is unknown, the
  reference's choice); the current mode is a stable English text key.
- **Configuration**: IPv4 unicast or host name, optional port (502); unit
  id 1-247 (the list), default 1; interval 30 s – 1 h (60 s by default: the
  reference moved to 30 s for the touch panel's sake). No secret.
- **Manifest**: categories `climate`, `environment`; no `keywords` /
  `countries` (Systemair is Swedish, sold in the Nordics and the EU:
  keywords "systemair, save, vtr, vsr, ventilation, VMC double flux" and
  countries SE, NO, FI, DK, DE, NL, FR, PL could be added once the store
  accepts them).
- **Not done**: scenes, widgets, setpoints, schedules, clock, alarm and
  filter resets, accessory sensors, RPM, air flows, Bluetooth (none).
