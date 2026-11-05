# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-05

### Added

- Systemair SAVE heat recovery ventilation (VTR, VSR, VSC) over local Modbus
  TCP, through SAVE Connect or an RS485 gateway (Elfin EW11…): active mode,
  ventilation on, fans running, supply, extract and outdoor temperatures,
  supply setpoint, extract humidity, fan outputs, days before the filter
  change, alarms A, B and C, manual stop allowed.
- Commands behind "Allow the commands" (off by default): the mode (auto,
  manual low / normal / high, crowded, refresh, fireplace, away, holiday)
  and "Start the ventilation (auto)"; "Stop the ventilation" never depends on
  the option, is kept until a start, and is sent again after a restart when
  it may not have landed (the guide lists when it can fail).
- "Test the connection" button, docs in English and French, cover image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-systemair/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-systemair/releases/tag/v0.1.1
