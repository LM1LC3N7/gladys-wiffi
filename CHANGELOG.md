# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The stall.biz Wiffi sensors (weatherman, rainyman, airsniffer, wiffi-wz…),
  read only, from the JSON telegrams each Wiffi sends over TCP to a receiver
  sub-container (`wiffi-push`, same image, one port published by Gladys).
- Temperature, humidity, soil moisture, pressure, brightness, angle, speed,
  rain and motion sensors, and texts; a Wiffi keyed by its MAC address, its
  features by the variable names. Invalid, `nan` or out-of-range values are
  never published; other units are listed in the status.
- Rain amounts (`mm/h`, and `mm` of the day or of the hour by their name), CO2
  (`ppm`) and VOC (`ppb`).
- Allowed senders (private addresses by default), telegrams cut at 64 KB,
  bounded connections, duration and rate; every refusal counted in the status.
- A Wiffi silent for the configured delay (5 min by default) is shown
  unreachable and named in the status, as is a sensor without a valid value.
