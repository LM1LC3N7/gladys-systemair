# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## home-assistant-systemair-modbus

<https://github.com/Howard0000/home-assistant-systemair-modbus> (Home
Assistant custom integration for Systemair SAVE and CD4 units over Modbus
TCP, version 1.3.0, commit dbfe5e0 of 2026-09-12), by Håvard Bertelsen. MIT
License; full text below.

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/app.js`: the
SAVE register map as the reference reads and writes it, checked against
Systemair's own "Modbus Variable List" (release 2021-03-01, revision 36):
register number N of the list is protocol address N - 1; the active user mode
(1161, 0 to 12) and its keys; the manual fan level (1131: 0 off, 2 low, 3
normal, 4 high) and the manual stop setting (1353); the user mode request
(1162, 1 auto to 7 holiday); the fans running flag (1351); the outdoor and
supply air temperatures (12102, 12103, signed tenths), the extract air
temperature and humidity of the standard sensors (12544, 12136); the supply
air setpoint (2001); the fan outputs (14001, 14002); the alarm types A, B
and C (15901-15903); the remaining filter time in seconds, lower word first
(7005-7006), 0 read as unknown; the stop as the manual mode at level off,
only when the unit allows it; the gateway profiles (function 4 for the input
registers with a fallback to function 3 on "illegal function"; SAVE Connect:
function 3 only, two registers a request, a pause between requests).

Changed: the Modbus TCP client (MBAP framing, one connection, one request at
a time, bounded answers) is the integration's own, without pymodbus; the
stop writes the level off before the manual mode and never falls back to the
low level (the reference does when the stop is not allowed: here the stop is
refused and said so); the manual levels write the level before the mode; no
retries of a write; values out of the list's ranges are unknown, never
published. Not ported: the CD4 controller, the climate and number entities
(setpoints, durations, free cooling, ECO), the filter reset button, the
estimated air flows, the 10 s delay after connecting.

```
MIT License

Copyright (c) 2026 Håvard Bertelsen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-testkit

`test/kit/` copies parts of gladys-testkit (Apache-2.0, same author as this
integration): the TCP server and the real clock of the tests.
