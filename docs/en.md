# Wiffi (stall.biz) for Gladys

This integration reads the sensors of [stall.biz](https://www.stall.biz) Wiffi
devices (weatherman, rainyman, airsniffer, wiffi-wz…): temperature, humidity,
pressure, brightness, wind, rain, locally, without any cloud and **read only**.
Each Wiffi sends its values to Gladys by itself, as JSON telegrams.

Unofficial integration, not affiliated with stall.biz. **Never tested with a real
device**: it follows the reference library `wiffi` 1.1.2 (used by Home Assistant);
your feedback is welcome.

## How it works

Gladys starts a small receiver (`wiffi-push`) next to the integration, listening on
a TCP port Gladys chooses. The Wiffi opens a connection to that port, sends one JSON
telegram ended by the byte 0x04, then closes. The integration reads the telegram,
recognizes the Wiffi by its MAC address and publishes its values.

## Setup

1. Install the integration, then **save** its configuration once (even empty):
   Gladys starts the receiver and chooses its port.
2. Reload the configuration screen: the port shows in the "Set up each Wiffi"
   section.
3. In the web page of each Wiffi:
   - set the CCU address ("CCU-IP") to the **IP address of the Gladys machine** on
     your local network (not the one of Gladys Plus or of a proxy);
   - set the port of the JSON telegrams (parameter `send_json`) to the port shown;
   - choose **JSON without header** (a telegram after HTTP headers is read too).
4. Allow this port in the firewall of the Gladys machine if it has one.
5. After the first telegram, the Wiffi appears in the **Discovery** tab: create it.

## Configuration

- **Allowed senders**: the IP addresses of your Wiffis (or a network such as
  `192.168.1.0/24`, /16 to /32), separated by commas, 16 at most. Empty: any
  private address of your local network (10.x, 172.16-31.x, 192.168.x, 169.254.x,
  local IPv6) is accepted. An invalid list refuses **every** telegram until it is
  corrected (the status gives the position of the wrong entry). Give your Wiffis a
  fixed IP address in your router. Depending on the Docker network setup, the
  receiver may see another address than the Wiffi's: the status shows the refused
  address.
- **Silent after (minutes)**: 2 to 60, 5 by default. A Wiffi that sends nothing for
  this long is shown unreachable and named in the status; a sensor without a valid
  value for this long (while its Wiffi talks) is named too.

## What is published

| Wiffi unit                                             | In Gladys                                             |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `gradC`                                                | temperature (°C), -60 to 100                          |
| `%` whose name holds "feucht" or "humid" (not "abs")   | humidity (%)                                          |
| `%` whose name holds "boden" or "soil"                 | soil moisture (%)                                     |
| `mb`                                                   | pressure (mbar), 300 to 1200                          |
| `lux`                                                  | brightness (lux)                                      |
| `grad`                                                 | angle (°), -90 to 360 (wind direction, sun elevation) |
| `km/h`, `m/s`                                          | speed                                                 |
| `mm/h`                                                 | precipitation (mm/h)                                  |
| `mm` whose name holds "heute", "tag", "day" or "24"    | precipitation of the day (mm/day)                     |
| `mm` whose name holds "stunde", "hour", "1h" or "_h"   | precipitation of the hour (mm/h)                      |
| `ppm` whose name holds "co2" or "kohlendioxid"         | CO2 (ppm)                                             |
| `ppm` whose name holds "co" (alone) or "kohlenmonoxid" | CO (ppm)                                              |
| `ppb` whose name holds "voc"                           | VOC (ppb)                                             |
| boolean whose name holds "regen" or "rain"             | rain sensor                                           |
| boolean whose name holds "beweg", "motion" or "pir"    | motion sensor                                         |
| text (wind direction in letters…)                      | text                                                  |

The rules on the names (rain of the day or of the hour, the gases) are a guess: the
variable names of each model were not read in the manufacturer's documentation.
An ambiguous name (day and hour both) and another gas in `ppm` (formaldehyde…) are
not published, only listed. To confirm with real devices: feedback is welcome.

Nothing is made up:

- an empty value, `nan`, a text, a comma decimal ("1,5") or a value outside the
  range of its kind is **not** published (never a 0 instead);
- another unit (`g/m3`…), a `mm` whose name says neither the day nor the hour (or
  says yesterday: "gestern"), or another boolean is not published: the status lists
  these variables (the first 20), so they can be added. `W/m2` (radiation) has no
  category in Gladys: never published;
- a Wiffi is kept (and offered in the Discovery) only once it sent at least one
  value it can publish;
- the network details of the Wiffi (IP address, SSID, Wi-Fi signal) are not
  published;
- when the unit of a variable changes, the existing feature is no longer fed and
  the status says so.

A value received more than a minute ago (kept by the receiver while the integration
restarted, for example) is published with its date; beyond 2 h, it is not
published. A telegram older than the last one applied is ignored.

## Limits of the receiver

So that a faulty or hostile device of the network cannot flood Gladys: an address
not allowed is closed before anything is read; a telegram is cut beyond 64 KB; 16
connections at most (4 per address, the oldest of the address makes room); a
connection is closed after 5 s without a byte and 15 s in all, after 4 telegrams
(an empty one counts) and beyond 129 KB; 60 telegrams a minute per address (240 in
all, empty ones count), the rest is ignored. Each refusal is counted in the status
for an hour. The number of connections a second from one address is not capped:
each one stays bounded as above. When Docker shows every Wiffi under one address (its gateway), they
share the 60 a minute of that address: enough for Wiffis sending every few seconds,
not for dozens of them.

The MAC address of a telegram is not a proof of who sent it: any machine allowed to
send can claim one. List your Wiffis in "Allowed senders". The table holds 32 Wiffis:
when it is full, the Wiffi not created in Gladys heard the longest ago makes room (a
Wiffi created in Gladys never does), and a Wiffi never created and not heard for a
day is forgotten.

## Security

The telegrams travel in clear: never expose the port to the
Internet. The integration sends nothing to the Wiffis and never commands them.

## Data kept

`/data/wiffi.json` keeps the list of the Wiffis, their features and the time of
their last telegram (32 Wiffis and 150 features per Wiffi at most), never a value.
When it cannot be read, it is never written over and it is read again every 10 s.
