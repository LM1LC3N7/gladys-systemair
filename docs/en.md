# Systemair SAVE for Gladys

Shows a **Systemair SAVE** heat recovery ventilation unit (VTR, VSR, VSC
with the SAVE controller, SAVE Touch or SAVE Light panel) in Gladys, through
**Modbus TCP** on your local network, without any cloud or account.
Unofficial integration, **not affiliated with Systemair**. **Never tested
with a real device**: it reads and writes the registers of Systemair's
"Modbus Variable List" (revision 36, main board software 2.0) as the
open-source home-assistant-systemair-modbus integration (Home Assistant)
uses them; please report what you see.

## Before you start

The SAVE controller speaks Modbus RTU on its connection board (RS485). Gladys
reaches it over your network through one of:

- **Systemair SAVE Connect** (the Internet Access Module, art. 211243):
  choose "Systemair SAVE Connect" as the gateway. Systemair's list says every
  register is a holding register over Modbus TCP: everything is read with
  function 3, two registers a request, with a pause between requests.
- **An RS485 to Modbus TCP gateway** (Elfin EW11 and the like), wired to the
  Modbus terminals of the unit: choose "RS485 gateway". The input registers
  are read with function 4; if the gateway answers "illegal function",
  function 3 is used from then on (the status says so).

Then:

- Give the gateway a fixed IP address in your router; Modbus TCP is on port
  502 unless you add another one (`192.168.1.50:8899`).
- Modbus TCP has **no password**: keep the gateway on a trusted network.
- The Modbus unit id is the Modbus address of the unit (Service,
  Communication, Modbus on its panel), 1 by default. An answer carrying
  another unit id is accepted.
- **"Stop the ventilation" needs the setting "Allow manual fan stop"**
  (register 1353) on the unit: without it, the unit refuses the stop and
  Gladys says so (the status shows it too).

## Installation

1. Install the integration from the Gladys store.
2. Enter the **IP address of the gateway**, pick the gateway type; save.
3. Open the **Discovery** tab and add the unit.

## What you get

One device, **Systemair ventilation**, with:

| Feature                                      | Notes                                                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supply, extract and outdoor air temperatures | °C (the standard sensors of the unit)                                                                                                                     |
| Supply air setpoint                          | °C, read only                                                                                                                                             |
| Extract air humidity                         | % (the standard sensor of the unit)                                                                                                                       |
| Supply and extract fan outputs               | %, read only                                                                                                                                              |
| Filter change in                             | days; not published when the unit reads 0                                                                                                                 |
| Ventilation mode                             | list: auto, manual low / normal / high, crowded, refresh, fireplace, away, holiday                                                                        |
| Current mode                                 | text: `auto`, `manual`, `stopped`, `crowded`, `refresh`, `fireplace`, `away`, `holiday`, `cooker-hood`, `vacuum-cleaner`, `cdi1`-`cdi3`, `pressure-guard` |
| Ventilation on, fans running                 | read only, 1 = yes ("on" is 0 only in the manual mode at level off)                                                                                       |
| Alarm type A, B, C                           | read only, 1 = active                                                                                                                                     |
| Manual stop allowed                          | read only, the setting of the unit                                                                                                                        |
| Start the ventilation (auto) / Stop          | buttons                                                                                                                                                   |

A value outside the ranges of the list (sensor missing, -40 to 80 °C, 0 to
100 %) is never published: Gladys keeps the last known value. The fan speeds
in RPM and the air flows are not published (no matching unit in Gladys).
The accessory sensors (room, extra controller, CO2) are not read yet.

The unit is read every 60 s (30 s to 1 h), in about twelve small requests
over one connection, with a pause between them (the touch panel shares the
bus), closed after. The test button, a Discovery scan, a reconnection of
Gladys or a restart of the integration never read it sooner than the
interval. Reads outside the interval:

- every command reads the unit right before writing, then reads the mode
  and the level back;
- "Stop the ventilation" and its resends;
- 5 s then 20 s after a command not confirmed, or after a stop that follows
  a start or a mode not confirmed;
- a new address, unit id or gateway saved is read at once.

The mode and the manual level are read first. When a later block fails (a
Modbus exception, no answer, the connection closed, a wrong answer), the
values read before are published anyway, and the failing block is tried
again once an hour.

## Commands

The mode and "Start the ventilation" are refused unless **Allow the
commands** is on (off by default). No switch: a voice assistant's "turn
everything off" never reaches the ventilation.

- **Mode**: auto, crowded, refresh, fireplace, away and holiday write the
  user mode request (register 1162, as the panel does); the timed modes last
  the time set on the unit. "Manual, low / normal / high" writes the manual
  level (1131), then the manual mode when the unit is not in it yet.
- **Start the ventilation (auto)** writes the auto mode. On a ventilation
  already running it writes nothing.
- Every command reads the unit right before writing (mode, manual level,
  fan level settings), writes nothing when the value already is right, and
  is confirmed only when the unit returns the echo of each write and then
  reads the value asked. A read back still showing the state before answers
  "not applied yet"; a command that may have reached the unit without being
  confirmed answers "sent, without confirmation": check the unit a few
  seconds later. A Modbus exception 1, 2 or 3 to the first write answers
  "refused" (not applied); any other answer "sent, without confirmation". A
  command whose first write cannot leave within 3.5 s is refused and nothing
  is sent.
- Also refused: when the **fan level settings** read differ from those
  learnt (see below), when **/data** cannot be read or written.
- The **mode** is refused while the ventilation is **stopped** (manual mode,
  level off: a mode would start it) and while a **stop sent from Gladys is
  kept**: press "Start the ventilation" first.

### Stop the ventilation

"Stop the ventilation" writes the manual level off (1131 = 0), then the
manual mode (1162 = 2): the unit never enters the manual mode at another
level. It does **not** depend on the option, on another command (a command
not written yet is cancelled, and the second write of a manual level never
leaves after it), on a read in progress or stuck (it is interrupted), on a
failed read or a wait between two tries, on the fan level settings, on
/data, nor on the configuration not read again from Gladys yet or made
invalid since (it then goes to the address of the kept stop, else the last
valid one kept in /data). It is tried again for 3.5 s after the press.

It can fail in these cases only, and the answer says so:

- no address known (never a valid one configured): "not sent";
- the unit cannot be reached within 3.5 s: "not sent" (or "not sent yet"
  while it still tries); the stop is kept and sent again by the next reads;
- the unit refuses the level off (exception 3: "Allow manual fan stop" is off
  on the unit): "refused", and the manual mode is not sent;
- another Modbus exception 1, 2 or 3: "refused";
- no answer, a wrong echo, or the ventilation read back running: "sent,
  without confirmation".

The stop is then **kept** (in /data, with the address): it is never lifted
by the time, only by "Start the ventilation" pressed (with the option), or
when the ventilation is read running **twice in a row** after it was seen
stopped (started from its panel). While it is kept, a read that finds the
ventilation running before it was seen stopped (or after a start that could
still land) sends the stop again: three sends at most, counting only the
sends that left (a resend that could not reach the unit is not counted).
The status says where the stop is: not confirmed yet, kept, or given up
after three sends. A stop that may not have landed when the integration
stopped is sent again when it restarts, even before the configuration is
read again.

## Identity of the unit

Systemair's Modbus list gives no serial number nor MAC address. The device
is therefore tied to the unit of the configuration, never to its IP address
(a new address keeps the device and its history). A light fingerprint is
learnt at the first read: the **fan level settings** (registers 1401 to
1410). When they change, another unit may answer at the address (or the
settings were changed on the panel): the mode and the start are refused
until "Test the connection" accepts the new settings (the stop does not
depend on it). Two units with the same settings are not told apart.

## /data

The integration keeps in `/data/systemair-state.json` (readable by itself
only): the time of the last read, the fingerprint, the last address and a
kept stop. Every read or write of it is bounded (2.5 s at most); a file that
cannot be read (or is not a regular file) is never taken for an empty one,
and the mode and the start are then refused; the stop waits 150 ms at most
for it before its first byte.

## What the integration does not do

It never writes a setting, the clock, the week schedule, the setpoints, a
password; it never resets the alarms, the filter counter nor the factory
settings. Only registers 1131 (values 0, 2, 3, 4) and 1162 (values 1 to 7)
are ever written.
