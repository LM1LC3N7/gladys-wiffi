// -----------------------------------------------------------------------------
// WiffiApp end to end on the fake Gladys: what is published, what never is,
// silence, order, dates, the configuration and /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { MINUTE, TIMINGS } from '../src/constants.js';
import { assertCoreDevice } from './helpers/coreFeature.js';
import {
  DEVICE,
  MAC,
  WEATHERMAN,
  createDevice,
  feature,
  makeApp,
  telegram,
} from './helpers/app.js';

const last = (env, key) => env.states(feature(key)).at(-1);

test('a first telegram: the Wiffi in the Discovery, keyed by its MAC, only supported features', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.discoveryDelay);
  const device = env.gladys.fake.discoveredDevices.find((d) => d.external_id === DEVICE);
  assert.ok(device, 'discovered');
  assert.equal(device.name, 'weatherman 112233');
  const keys = device.features.map((f) => f.external_id.split(':').at(-1)).sort();
  assert.deepEqual(keys, [
    'w_barometer',
    'w_feuchte_rel',
    'w_lux',
    'w_regen',
    'w_taupunkt',
    'w_temperatur',
    'w_wind_dir',
    'w_wind_mittel',
    'w_windrichtung',
  ]);
  const byKey = Object.fromEntries(
    device.features.map((f) => [f.external_id.split(':').at(-1), f]),
  );
  assert.deepEqual(
    [byKey.w_temperatur.category, byKey.w_temperatur.type, byKey.w_temperatur.unit],
    ['temperature-sensor', 'decimal', 'celsius'],
  );
  assert.equal(byKey.w_feuchte_rel.category, 'humidity-sensor');
  assert.equal(byKey.w_barometer.unit, 'milli-bar');
  assert.equal(byKey.w_regen.category, 'rain-sensor');
  assert.equal(byKey.w_windrichtung.category, 'text');
  assert.ok(device.features.every((f) => f.read_only === true));
  assert.ok(device.params.some((p) => p.name === 'WIFFI_MAC' && p.value === '5C:CF:7F:11:22:33'));
  // Nothing published before the device exists in Gladys.
  assert.equal(env.gladys.fake.states.length, 0);
  // The status names what is not published.
  await env.time.advance(1000);
  assert.match(env.status().message.en, /w_feuchte_abs \(g\/m3\)/);
  assert.match(env.status().message.en, /w_sonne_scheint \(boolean\)/);
  assert.doesNotMatch(env.status().message.en, /w_ip/);
  assert.equal(env.status().connected, true);
  // The rules of the core (its own lists and normalizeSupportedOptions when cloned).
  assertCoreDevice(device, 'weatherman');
});

test('created: the valid values are published; nan, text as a number, out of range never', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.discoveryDelay);
  await createDevice(env);
  await env.time.advance(TIMINGS.flushInterval);
  // Received 2 s before the creation: published again, without a date (still live).
  assert.equal(last(env, 'w_temperatur').state, 12.4);
  assert.equal(last(env, 'w_temperatur').created_at, undefined);
  assert.equal(last(env, 'w_regen').state, 0);
  assert.equal(last(env, 'w_windrichtung').text, 'NO');
  assert.equal(env.states(feature('w_taupunkt')).length, 0, 'nan is no value');
  await env.send(
    telegram({
      values: {
        w_temperatur: '',
        w_barometer: '1,013',
        w_lux: '-5',
        w_feuchte_rel: '101',
        w_regen: 'yes',
        w_wind_mittel: 'Aus',
      },
    }),
    {},
  );
  await env.time.advance(TIMINGS.flushInterval);
  for (const key of [
    'w_temperatur',
    'w_barometer',
    'w_lux',
    'w_feuchte_rel',
    'w_regen',
    'w_wind_mittel',
  ]) {
    assert.equal(env.states(feature(key)).length, 1, `${key}: nothing new published`);
  }
  await env.send(telegram({ values: { w_temperatur: '13.1', w_regen: 'true' } }));
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 13.1);
  assert.equal(last(env, 'w_regen').state, 1);
});

test('order and age: an older telegram never overwrites; late ones dated; over 2 h dropped', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.discoveryDelay);
  await createDevice(env);
  await env.time.advance(TIMINGS.flushInterval);
  // Numbered before the one applied by the same receiver: never written over it,
  // even dated later (a wall clock that stepped).
  await env.send(telegram({ values: { w_temperatur: '5' } }), { seq: 1 });
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 12.4, 'older than the last applied');
  // A receiver restarted numbers from 1 again: taken.
  await env.send(telegram({ values: { w_temperatur: '6' } }), {
    seq: 1,
    boot: 'fedcba9876543210',
    age: 30_000,
  });
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 6);
  await env.time.advance(10 * MINUTE);
  await env.send(telegram({ values: { w_temperatur: '7' } }), { age: 3 * MINUTE });
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 7);
  assert.equal(
    last(env, 'w_temperatur').created_at,
    new Date(env.time.now() - 3 * MINUTE - TIMINGS.flushInterval).toISOString(),
  );
  await env.send(telegram({ values: { w_temperatur: '8' } }), { age: TIMINGS.maxAge + 1000 });
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 7);
  await env.time.advance(1000);
  assert.match(env.status().message.en, /older than 2 h/);
});

test('silence: the Wiffi unreachable and named; a mute sensor named; back to local', async (t) => {
  const env = await makeApp({ config: { silence_minutes: 3 } });
  t.after(() => env.stop());
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.discoveryDelay);
  await createDevice(env);
  const transport = () =>
    env.gladys.fake.transports.filter((x) => x.device_external_id === DEVICE).at(-1)?.transport;
  assert.equal(transport(), 'local');
  // Every minute a telegram whose temperature is nan.
  for (let i = 0; i < 3; i += 1) {
    await env.time.advance(MINUTE);
    await env.send(telegram({ values: { w_temperatur: 'nan' } }));
  }
  await env.time.advance(TIMINGS.tick);
  assert.match(env.status().message.en, /no valid value for 3 min from .*w_temperatur/);
  assert.match(env.status().message.en, /w_taupunkt/);
  assert.doesNotMatch(env.status().message.en, /w_barometer/);
  // Then nothing for 3 minutes.
  await env.time.advance(3 * MINUTE);
  assert.equal(transport(), 'unreachable');
  assert.match(env.status().message.en, /weatherman 5C:CF:7F:11:22:33: silent for 3 min/);
  assert.match(env.status().message.fr, /muet depuis 3 min/);
  assert.equal(env.status().connected, false);
  await env.send(WEATHERMAN);
  assert.equal(transport(), 'local');
});

test('allowed senders: another address refused, an invalid list refuses everyone', async (t) => {
  const env = await makeApp({ config: { allowed_addresses: '192.168.1.60, 10.1.0.0/16' } });
  t.after(() => env.stop());
  assert.equal(env.app.receiverEnv().ALLOWED, '192.168.1.60,10.1.0.0/16');
  await env.send(WEATHERMAN, { from: '192.168.1.50' });
  await env.send(WEATHERMAN, { from: '8.8.8.8' });
  await env.time.advance(TIMINGS.discoveryDelay);
  assert.equal(env.gladys.fake.discoveredDevices.length, 0);
  await env.send(WEATHERMAN, { from: '10.1.4.5' });
  await env.time.advance(TIMINGS.discoveryDelay);
  assert.equal(env.gladys.fake.discoveredDevices.length, 1);
  assert.match(env.status().message.en, /2 telegrams refused: sender not allowed \(8\.8\.8\.8\)/);
  await env.gladys.fake.configUpdated({ allowed_addresses: '192.168.1.60, my-wiffi' });
  await env.time.settle();
  await env.send(telegram({ values: { w_temperatur: '1' } }), { from: '192.168.1.60' });
  await env.time.advance(1000);
  assert.match(env.status().message.en, /entry 2 is not an IP address/);
  assert.doesNotMatch(env.status().message.en, /my-wiffi/, 'an invalid entry is never shown');
  assert.equal(env.app.receiverEnv().ALLOWED, 'none');
});

test('a unit changed under the same name is never published into the old feature', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.discoveryDelay);
  await createDevice(env);
  await env.time.advance(TIMINGS.flushInterval);
  await env.send(
    telegram().replace('"unit":"gradC","value":"12.4"', '"unit":"gradF","value":"54.3"'),
  );
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 12.4);
  assert.equal(env.states(feature('w_temperatur')).length, 1);
  await env.time.advance(1000);
  assert.match(env.status().message.en, /unit changed, not published: w_temperatur/);
});

test('unreadable telegrams and identities: counted, never a device, the others go on', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  await env.send('POST / HTTP/1.1\r\nHost: x\r\n\r\n' + WEATHERMAN);
  await env.send('<html>');
  await env.send(WEATHERMAN.replace('5C:CF:7F:11:22:33', 'FF:FF:FF:FF:FF:FF'));
  await env.send('{"__proto__":{"x":1},"vars":[],"Systeminfo":{}}');
  await env.time.advance(TIMINGS.discoveryDelay);
  assert.equal(
    env.gladys.fake.discoveredDevices.length,
    1,
    'the telegram after HTTP headers is read',
  );
  assert.equal({}.x, undefined);
  const { en } = env.status().message;
  assert.match(en, /1 telegram refused: not JSON/);
  assert.match(en, /2 telegrams refused: no MAC address/);
});

test('connected: getConfig failing is tried again without end, then everything starts', async (t) => {
  const env = await makeApp({ connect: false });
  t.after(() => env.stop());
  const real = env.gladys.getConfig.bind(env.gladys);
  let failures = 3;
  let calls = 0;
  env.gladys.getConfig = async () => {
    calls += 1;
    // The first call is the SDK's own resynchronization: the app's come after.
    if (calls > 1 && failures > 0) {
      failures -= 1;
      throw new Error('503');
    }
    return real();
  };
  await env.gladys.connect();
  await env.time.settle();
  assert.equal(env.status().connected, false);
  assert.match(env.status().message.en, /configuration could not be read/);
  assert.equal(env.channels.length, 0, 'nothing started on a configuration not read');
  await env.time.advance(5000);
  await env.time.advance(10_000);
  assert.equal(env.channels.length, 0);
  await env.time.advance(30_000);
  assert.equal(failures, 0);
  assert.equal(env.channels.length, 1, 'started once read');
  // And again on a later reconnection: one failure, then the retry.
  failures = 1;
  env.gladys.emit('connected');
  await env.time.settle();
  assert.match(env.status().message.en, /configuration could not be read/);
  await env.time.advance(5000);
  assert.doesNotMatch(env.status().message.en, /configuration could not be read/);
});

test('the receiver: started with its secret, restarted with new senders, retried on failure', async (t) => {
  const env = await makeApp({ containers: [] });
  t.after(() => env.stop());
  assert.match(env.status().message.en, /receiver of the telegrams is not running \(unknown\)/);
  assert.equal(env.channels.length, 0);
  const token = env.gladys.fake.config.channel_token;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  env.gladys.fake.containers.push(
    ...JSON.parse(JSON.stringify((await import('./helpers/app.js')).RUNNING)),
  );
  await env.time.advance(TIMINGS.receiverRetry);
  assert.equal(env.channels.length, 1);
  assert.equal(env.channel.options.token, token);
  assert.doesNotMatch(env.lines.join('\n'), new RegExp(token), 'the secret is never logged');
  assert.doesNotMatch(JSON.stringify(env.gladys.fake.connectionStatuses), new RegExp(token));
});

test('/data: the Wiffis kept across a restart; unreadable never written over, read again', async (t) => {
  const store = memoryStore();
  const env = await makeApp({ store });
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.saveDelay);
  assert.ok(store.data.devices[MAC].features.w_temperatur);
  assert.equal(JSON.stringify(store.data).includes('12.4'), false, 'never a value in /data');
  await env.stop();

  // Restarted: the Discovery has the Wiffi before any telegram; silent since its last one.
  const again = await makeApp({ store });
  t.after(() => again.stop());
  assert.ok(again.gladys.fake.discoveredDevices.some((d) => d.external_id === DEVICE));

  const broken = memoryStore(store.data, { unreadable: true });
  const env3 = await makeApp({ store: broken });
  t.after(() => env3.stop());
  await env3.send(telegram({ mac: '5C:CF:7F:00:00:01' }));
  await env3.time.advance(TIMINGS.saveDelay * 2);
  assert.equal(broken.saves, 0, 'never written over a file not read');
  assert.match(env3.status().message.en, /cannot be read/);
  const loads = broken.loads;
  broken.unreadable = false;
  await env3.time.advance(TIMINGS.dataRetry);
  assert.equal(broken.loads, loads + 1);
  await env3.time.advance(TIMINGS.saveDelay);
  assert.ok(broken.saves >= 1);
  assert.deepEqual(
    Object.keys(broken.data.devices).sort(),
    ['5ccf7f000001', MAC].sort(),
    'both kept',
  );
});

test('publisher: 250 states a minute at most; a value that waited over a minute carries its date', async () => {
  const { StatePublisher } = await import('../src/publisher.js');
  const sent = [];
  let wall = 1_000_000;
  let mono = 0;
  const publisher = new StatePublisher({
    gladys: {
      publishChangedStates: async (batch) => {
        sent.push(...batch);
        return { success: true, count: batch.length };
      },
    },
    now: () => wall,
    clock: () => mono,
    timers: { setInterval: () => 0, clearInterval: () => {} },
  });
  for (let i = 0; i < 300; i += 1) publisher.push(`ext:w:f${i}`, { state: i }, wall);
  await publisher.flush();
  await publisher.flush();
  assert.equal(sent.length, 250);
  assert.ok(
    sent.every((s) => s.created_at === undefined),
    'sent at once: no date',
  );
  mono += 60_001;
  wall += 60_001;
  await publisher.flush();
  assert.equal(sent.length, 300);
  assert.equal(sent.at(-1).created_at, new Date(wall - 60_001).toISOString(), 'waited: dated');
  publisher.push('ext:w:old', { state: 1 }, wall - TIMINGS.maxAge - 1);
  publisher.push('ext:w:new', { state: 2 }, wall);
  publisher.push('ext:w:new', { state: 3 }, wall - 1000);
  await publisher.flush();
  assert.deepEqual(
    sent.slice(300).map((s) => [s.device_feature_external_id, s.state]),
    [['ext:w:new', 2]],
    'too old dropped; an older value never replaces a newer one',
  );
});

test('created later: the recent values again, dated; nothing stale at a reconnection', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  await env.send(WEATHERMAN);
  await env.time.advance(3 * MINUTE);
  await createDevice(env);
  await env.time.advance(TIMINGS.flushInterval);
  const state = last(env, 'w_temperatur');
  assert.equal(state.state, 12.4);
  assert.equal(
    state.created_at,
    new Date(env.time.now() - 3 * MINUTE - TIMINGS.flushInterval).toISOString(),
  );
  const count = env.gladys.fake.states.length;
  env.gladys.emit('connected');
  await env.time.advance(TIMINGS.flushInterval * 3);
  assert.equal(
    env.gladys.fake.states.length,
    count,
    'a reconnection republishes nothing by itself',
  );
  // But the next telegram is published again, even unchanged (Gladys forgot it).
  await env.send(WEATHERMAN);
  await env.time.advance(TIMINGS.flushInterval);
  assert.equal(last(env, 'w_temperatur').state, 12.4);
  assert.ok(env.states(feature('w_temperatur')).length >= 2);
  // Not heard for longer than the silence delay before the creation: not published again.
  const other = await makeApp();
  t.after(() => other.stop());
  await other.send(WEATHERMAN);
  await other.time.advance(6 * MINUTE);
  await createDevice(other);
  await other.time.advance(TIMINGS.flushInterval);
  assert.equal(other.gladys.fake.states.length, 0);
});

test('32 Wiffis at most; 150 features per Wiffi; the others told, never mixed', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  for (let i = 0; i < 33; i += 1) {
    const mac = `5C:CF:7F:00:00:${i.toString(16).padStart(2, '0').toUpperCase()}`;
    await env.send(telegram({ mac }));
  }
  await env.time.advance(TIMINGS.discoveryDelay);
  assert.equal(env.gladys.fake.discoveredDevices.length, 32);
  assert.match(env.status().message.en, /refused: more than 32 Wiffis/);
});

test('configurations saved back to back apply one by one, the last one wins', async (t) => {
  const env = await makeApp();
  t.after(() => env.stop());
  const calls = [];
  const real = env.gladys.startContainer.bind(env.gladys);
  let slow = true;
  env.gladys.startContainer = async (name, options) => {
    calls.push(options.env.ALLOWED);
    if (slow) {
      slow = false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return real(name, options);
  };
  await Promise.all([
    env.gladys.fake.configUpdated({ allowed_addresses: '10.0.0.1' }),
    env.gladys.fake.configUpdated({ allowed_addresses: '10.0.0.2' }),
  ]);
  await env.time.settle();
  assert.deepEqual(calls, ['10.0.0.1', '10.0.0.2']);
  assert.equal(JSON.parse(env.app.lastReceiverEnv).ALLOWED, '10.0.0.2');
  assert.deepEqual(env.app.config.allowed, ['10.0.0.2']);
});

test('a telegram dated in the future is dated now: the silence counts from now', async (t) => {
  const env = await makeApp({ config: { silence_minutes: 3 } });
  t.after(() => env.stop());
  await env.send(WEATHERMAN, { age: -10 * MINUTE });
  await env.time.advance(3 * MINUTE + TIMINGS.tick);
  assert.match(env.status().message.en, /silent for 3 min/);
});
