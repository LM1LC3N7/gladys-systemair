# gladys-systemair

[Gladys Assistant](https://gladysassistant.com) external integration for
**Systemair SAVE** heat recovery ventilation (VTR, VSR, VSC with the SAVE
controller) over **Modbus TCP** on the local network, through Systemair's
SAVE Connect module or an RS485 gateway such as the Elfin EW11 (no cloud,
no password): active mode, ventilation on, fans running, supply, extract
and outdoor temperatures, supply setpoint, extract humidity, fan outputs,
days before the filter change, alarms A, B and C; the mode and "Start the
ventilation" behind an off-by-default option, and "Stop the ventilation"
never behind that option. **Never tested with a real device. Not affiliated
with Systemair.** Modbus TCP has no authentication: keep the gateway on a
trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SystemairApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  requests, decoders, allowed writes (pure)
                                  ├─ src/devices.js          the device and its states (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/systemair-state.json, bounded, regular file only
```

- **Reads**: one Modbus TCP connection per poll (every 60 s, 30 s – 1 h,
  start to start), a dozen small requests with a pause between them (the
  registers of Systemair's "Modbus Variable List", rev. 36), then closed.
  Input registers with function 4 (function 3 once the gateway refuses it,
  or always through SAVE Connect, two registers a request). The mode and the
  manual level come first; the other blocks never stop the values read
  before them. Never sooner than the interval (test button, Discovery,
  reconnection, unchanged configuration, container restart: the time of the
  last read is kept in `/data`, written at most once a minute, before the
  read).
- **Device**: `ext:<selector>:systemair:unit` (the Modbus map gives no
  serial number nor MAC; the address is never part of the id; the fan level
  settings 1401-1410 are a light fingerprint). Every feature is always
  published; no switch, no writable binary or fan.
- **Commands** (`allow_commands`, off by default): one `text/select` (the
  mode: register 1162, and 1131 for the manual levels) and "Start the
  ventilation" (1162 = 1, auto). Decided on a fresh read in their own
  session; refused when the settings differ from those learnt or /data is
  unreadable; the mode also on a stopped ventilation and while a stop is
  kept. First write within 3.5 s of the click or not at all, confirmed only
  by the echoes and the values read back (by 4.3 s).
- **Stop the ventilation** (protective: 1131 = 0, then 1162 = 2): never
  behind the option, takes the line from anything, cancels a command not
  written yet, retried for 3.5 s, goes to the address kept in `/data` when
  the configuration is not read yet. Then **kept** in `/data`: never lifted
  by the time, only by "Start the ventilation" or by the ventilation read
  running twice in a row after it was seen stopped; resent (three sends that
  left at most) when the ventilation reads running before it was seen
  stopped; sent again at container start, before the configuration, when it
  may not have landed.
- **Not done**: settings, setpoints, schedules, clock, alarm and filter
  resets, accessory sensors, RPM and air flows, the CD4 controller.

## Development

```bash
npm install
npm test             # node --test (fake Gladys of the SDK, fake unit, mocked clock, real clock x20)
npm run lint
npm run format:check
npm run audit
npm run cover        # cover.png, plain Node
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and the decisions.

## Credits and license

Register map ported from
[home-assistant-systemair-modbus](https://github.com/Howard0000/home-assistant-systemair-modbus)
(MIT) and checked against Systemair's Modbus Variable List; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This integration is
licensed under the Apache License 2.0 ([LICENSE](LICENSE)).
