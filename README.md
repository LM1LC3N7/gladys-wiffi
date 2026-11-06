# gladys-wiffi

[Gladys Assistant](https://gladysassistant.com) external integration for the
[stall.biz](https://www.stall.biz) Wiffi sensors (weatherman, rainyman, airsniffer,
wiffi-wz…): temperature, humidity, pressure, brightness, wind and rain, locally and
read only, from the JSON telegrams each Wiffi sends over TCP.

Unofficial, not affiliated with stall.biz. Never tested with a real device.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Architecture and rules for contributors: [CLAUDE.md](CLAUDE.md).
- What is left and the decisions taken: [TODO.md](TODO.md).

## How it works

A sub-container of the same image (`wiffi-push`, `node src/receiver.js`) listens on
one TCP port published by Gladys. It checks the sender, the size, the connections
and the rate, and hands each telegram over an authenticated channel to the main
container, which reads it strictly and publishes only valid measurements of
supported units. A Wiffi silent for the configured delay is shown unreachable.

## Development

```bash
npm install
npm test               # node --test (fake Gladys of the SDK, real receiver on the loopback)
npm run lint
npm run format:check
npm run cover          # regenerates cover.png
npm run mutants        # replays the mutants of test/mutants.mjs, one at a time
```

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
