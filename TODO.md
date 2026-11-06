# TODO

## Status

Milestone 1 (0.1.0, local commits, not pushed): the stall.biz Wiffis read only,
from the JSON telegrams they send to the `wiffi-push` sub-container. Never tested
with a real Wiffi: only with telegrams built after the reference library, the real
receiver and the real channel on the loopback.

## Next

- Test with a real Wiffi: the exact variable names and units of each model
  (weatherman, rainyman, airsniffer, wiffi-wz, pulsecounter), how often each one
  sends, whether a firmware sends `nan` or other placeholders, whether 0x03 is
  still used as an end.
- Units met in the field and not mapped yet (`g/m3`, a `mm` named neither for the
  day nor for the hour…): the status lists them; add each one only with its meaning
  confirmed. The exact variable names of the Rainyman are not checked (manufacturer
  documentation not read): the day/hour rule on the name is a guess to confirm.
- Counters (`_heute`, `_pro_h`, pulse counter): never published as an energy index
  before their meaning and their reset are known.
- Commands (buzzer, relays of some Wiffis): out of scope, read only.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and both `docker_image` tags (`ghcr.io/lm1lc3n7/gladys-wiffi:0.1.0`,
  main and `wiffi-push`).
- **Reference**: wiffi 1.1.2 (MIT, mampfes, frozen since 2023-02, accepted by
  Louis as a reference to take with care), license checked in its `LICENSE`;
  Home Assistant's wiffi integration (Apache-2.0) for the units, the feature key
  and the silence delay. Ported, not copied; credited in `THIRD_PARTY_NOTICES.md`,
  shipped in the image. The stall.biz site answers scripts with a firewall page:
  not worked around, the manufacturer's documentation was not read.
- **Neighbour**: gladys-nasweb (receiver sub-container, HMAC channel taken as is,
  publisher, status), read only.
- **Units**: the ones the references map (`gradC`, `grad`, `%`, `mb`, `lux`) and
  the ones the device writes literally and the core carries (`km/h`, `m/s`, `mm/h`,
  `ppm` -> CO2 or CO, `ppb` -> VOC, by their name only, review r2); `mm` by its name
  (day or hour, not both; yesterday never). Another gas in `ppm` is never shown as CO2. A
  daily rain total that falls to 0 at midnight is a real value, not an index.
  **Names** (review r3): a stem written inside longer words (`feucht`, `boden`,
  `regen`, `voc`, `co2`, `kohlendioxid`…) matches anywhere; a short word that hides
  in others (`co` in `cooling`, `pir` in `expired`) and every day or hour word
  (`tag` in `stage` or `montag`) only as a word between `_` (`rain` as the start of
  one: not `drain`); exclusions (`abs`, yesterday) anywhere. `co_2` (CO2, or a
  second CO probe) is not published. Every alternative has a test and a mutant
  (`test/mutants.mjs`).
  `W/m2` has no category in Gladys (review r1). `grad` goes to
  `angle-sensor` with the unit `degree`, as the core's Netatmo integration does
  (the core has no unit list for that category). A `%` is a humidity or a soil
  moisture only by its name, else not published.
- **Ranges**: a value outside the range of its kind is no measurement (a probe
  unplugged), never published, the sensor then named "no valid value".
- **Allowed senders**: empty = private addresses only; an invalid list refuses
  everyone (`ALLOWED=none`), never falls back to "private".
- **Freshness**: dated by the receiver when it arrives; older than the last
  applied for the Wiffi: ignored; waited over a minute: published with its date;
  over 2 h: dropped. The silence is decided on the monotonic clock.
- **Table of the Wiffis** (review r1): a Wiffi enters only with a publishable value;
  full (32), the one not created in Gladys heard the longest ago makes room; never
  created and silent for 24 h: forgotten. The MAC is no authentication: the docs
  recommend the allowed senders.
- **No action, no command handler**: the integration is read only.
- **Not in the manifest**: `keywords`, `countries` (not used by the store yet).
