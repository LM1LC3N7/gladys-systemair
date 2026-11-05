# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`). It reads a Systemair
SAVE ventilation unit (VTR, VSR, VSC) over Modbus TCP (SAVE Connect or an
RS485 gateway, port 502, no cloud, no authentication) and shows it as one
Gladys device; the mode and the start behind an off-by-default option,
"Stop the ventilation" never behind it. Never tested with a real device, not
affiliated with Systemair. Read **[TODO.md](./TODO.md) first**: status,
decisions, next milestones.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi ci                                     # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap only (boot(): a stop pending in /data goes first)
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                SystemairApp: the line (one session), polling, backoff, device,
                          states, badge, status, test button, commands, kept stop
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    requests, decoders, derived values, the only writes allowed (pure)
src/devices.js            -> the Gladys device and its states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/systemair-state.json: last read, identity, address, kept stop
src/config.js             config_schema normalized (host, unit_id, gateway, allow_commands, interval, language)
src/constants.js          blocks, commands, feature roles, ranges, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeSystemair.js  the fake unit (injected connector, and frames for a real TCP server)
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `systemair:unit` (no serial number nor
  MAC in the Modbus map: frozen rule), feature roles in `FEATURES` of
  `src/constants.js`. Every role is always built.
- Manifest keys (`host`, `unit_id`, `gateway`, `allow_commands`,
  `poll_interval`, `language`, the action `test_connection`) are frozen.
- **One Modbus connection at a time, one request at a time**: everything
  goes through `useLine`; a command takes the line from a poll, the stop
  from anything. Polls are paced (the touch panel shares the bus).
- **Registers from Systemair's "Modbus Variable List"** (rev. 36), never
  guessed: number N is address N - 1; input registers with function 4 (3
  through SAVE Connect).
- **Commands**: never a switch, a writable binary or a writable fan; the
  mode and the start refused unless `allow_commands` (checked on arrival and
  in `beforeSend` of every write); decided on a fresh read in the same
  session; first write within 3.5 s; confirmed only by the echoes and a read
  back equal to the value asked; never retried; the ack never waits for
  Gladys.
- **The stop is never held back** (option, other command, stuck read,
  backoff, identity, /data, configuration not read). Level off before the
  manual mode; a refused level never sends the mode. The kept stop is never
  lifted by the time: only by a start pressed with the option or by the
  ventilation read running twice in a row after it was seen stopped. Only a
  send that left counts as one of its three resends.
- Only registers 1131 (0, 2, 3, 4) and 1162 (1 to 7) are ever written
  (`ALLOWED_WRITES`, checked in `writeRequest`).
- Never read sooner than the interval (button, scan, reconnection, restart).
- **/data is bounded**: every read and write of it ends within 2.5 s; only a
  regular file is read; unreadable is never empty.
- **Answers are hostile**: MBAP frames bounded and checked; implausible
  values unknown; a text is never published as 0; never log the bytes.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network, except `test/realclock.test.js` (127.0.0.1 only).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
