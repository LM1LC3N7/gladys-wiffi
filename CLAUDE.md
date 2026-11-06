# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "silence" # tests whose name matches
npm run mutants                           # the mutants, one at a time (memcap on the dev VM)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers (shared with the tests); read only, no onSetValue
src/app.js                        WiffiApp: receiver, channel, telegrams, silence, status, /data
src/telegram.js                   strict reading of a JSON telegram (wiffi 1.1.2)
src/model.js                      unit -> Gladys feature, ranges, devices for the Discovery
src/publisher.js                  states within the Gladys budget, dated when late
src/push/service.js               the receiver (sub-container wiffi-push): TCP, every bound
src/receiver.js                   entry point of the sub-container
src/channel.js                    HMAC channel between the containers (from gladys-nasweb)
src/store.js                      /data/wiffi.json, bounded, FIFO refused
src/config.js                     config normalization, allowed senders
src/i18n.js                       the status texts (en, fr)
test/                             node --test: fake Gladys, real receiver on the loopback, real clock x20
test/mutants.mjs, scripts/mutants.mjs   mutants of the guards, replayed one at a time
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

## Rules of this integration

- **Read only.** No command, no action: nothing is ever sent to a Wiffi.
- **Never a made-up value.** Empty, `nan`, text, comma decimal or out of range:
  nothing published (never 0). An unknown unit: listed in the status.
- **Bounded reception.** Every limit of `src/push/service.js` has a test in
  `test/receiver.test.js`; a new one needs its test and its mutant.
- **The silence** is decided on the monotonic clock only.
