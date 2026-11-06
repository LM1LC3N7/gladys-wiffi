// -----------------------------------------------------------------------------
// Real clocks and timers, sped up 20 times, with the REAL receiver and the
// REAL channel on the loopback: a telegram sent over TCP reaches Gladys, the
// background round keeps its period (measured), and the Wiffi is shown
// unreachable once silent for the configured delay, not before.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WiffiApp } from '../src/app.js';
import { ChannelClient } from '../src/channel.js';
import { MINUTE, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { startReceiver } from '../src/push/service.js';
import { memoryStore } from '../src/store.js';
import { DEVICE, RUNNING, WEATHERMAN, createDevice } from './helpers/app.js';

const SPEED = 20;

function spedUp() {
  const start = performance.now();
  const wall0 = Date.now();
  const handles = new Set();
  const sim = () => (performance.now() - start) * SPEED;
  return {
    now: () => wall0 + sim(),
    mono: sim,
    timers: {
      setTimeout: (fn, ms) => {
        const h = setTimeout(() => {
          handles.delete(h);
          fn();
        }, ms / SPEED);
        handles.add(h);
        return h;
      },
      clearTimeout: (h) => {
        handles.delete(h);
        clearTimeout(h);
      },
      setInterval: (fn, ms) => {
        const h = setInterval(fn, ms / SPEED);
        handles.add(h);
        return h;
      },
      clearInterval: (h) => {
        handles.delete(h);
        clearInterval(h);
      },
    },
    get pending() {
      return handles.size;
    },
    close() {
      for (const h of handles) clearTimeout(h);
      handles.clear();
    },
  };
}

const until = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('real time x20: telegram over TCP, round period, silence after the delay', async (t) => {
  const token = 'r'.repeat(32);
  const time = spedUp();
  // The receiver dates the telegrams on the same (sped up) wall clock.
  const service = await startReceiver({
    env: {
      CHANNEL_TOKEN: token,
      TCP_PORT: '0',
      CHANNEL_PORT: '0',
      TCP_HOST: '127.0.0.1',
      ALLOWED: '127.0.0.1',
    },
    now: time.now,
  });
  const gladys = createFakeGladys({
    selector: 'wiffi',
    config: { channel_token: token, silence_minutes: 2, allowed_addresses: '127.0.0.1' },
    containers: RUNNING,
  });
  const app = new WiffiApp({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: memoryStore(),
    now: time.now,
    clock: time.mono,
    timers: time.timers,
    createChannel: (o) =>
      new ChannelClient({ ...o, host: '127.0.0.1', port: service.channel.port }),
  });
  t.after(async () => {
    await app.stop();
    time.close();
    await service.stop();
  });
  registerHandlers(gladys, app);
  const ticks = [];
  const tick = app.tick.bind(app);
  app.tick = () => {
    ticks.push(time.mono());
    return tick();
  };
  await gladys.connect();
  await until(() => app.channelUp, 'channel up');

  const send = () =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: service.port }, () =>
        socket.end(`${WEATHERMAN}\x04`),
      );
      socket.on('close', resolve);
      socket.on('error', reject);
    });
  // Before the send: the telegram cannot be heard earlier.
  const heardAt = time.mono();
  await send();
  await until(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === DEVICE),
    'discovered',
  );
  await createDevice({ gladys, time: { settle: () => new Promise((r) => setTimeout(r, 20)) } });
  await until(
    () => gladys.fake.states.some((s) => s.device_feature_external_id.endsWith(':w_temperatur')),
    'state',
  );

  const transport = () =>
    gladys.fake.transports.filter((x) => x.device_external_id === DEVICE).at(-1)?.transport;
  assert.equal(transport(), 'local');
  await until(() => transport() === 'unreachable', 'silent', 20_000);
  const silentAfter = time.mono() - heardAt;
  assert.ok(silentAfter >= 2 * MINUTE, `not before the delay (${silentAfter} ms)`);
  assert.ok(
    silentAfter <= 2 * MINUTE + 2 * TIMINGS.tick,
    `within a round or two (${silentAfter} ms)`,
  );

  const gaps = ticks.slice(1).map((v, i) => v - ticks[i]);
  assert.ok(gaps.length >= 10, `${gaps.length} rounds`);
  for (const gap of gaps) {
    assert.ok(gap >= 0.9 * TIMINGS.tick && gap <= 1.5 * TIMINGS.tick, `period ${gap} ms`);
  }
  await send();
  await until(() => transport() === 'local', 'back');
});
