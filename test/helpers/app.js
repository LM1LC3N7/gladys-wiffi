// -----------------------------------------------------------------------------
// WiffiApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store, a fake channel to the receiver and a
// clock that only moves when the test advances it (timers fired in order).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WiffiApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { RECEIVER } from '../../src/constants.js';
import { memoryStore } from '../../src/store.js';

export const SELECTOR = 'wiffi';
export const MAC = '5ccf7f112233';
export const BOOT = '0123456789abcdef';
export const WALL0 = Date.parse('2026-11-05T12:00:00.000Z');
export const DEVICE = `ext:${SELECTOR}:wiffi:${MAC}`;
export const feature = (key, mac = MAC) => `ext:${SELECTOR}:wiffi:${mac}:${key}`;
export const WEATHERMAN = readFileSync(
  new URL('../fixtures/weatherman.txt', import.meta.url),
  'utf8',
);

/** The weatherman fixture with other values, MAC or variables. */
export function telegram({ mac, values = {}, extra = [], drop = [] } = {}) {
  let text = WEATHERMAN;
  if (mac) text = text.replace('5C:CF:7F:11:22:33', mac);
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`("homematic_name":"${key}"[^}]*"value":)("[^"]*"|nan)`);
    text = text.replace(re, `$1${JSON.stringify(value)}`);
  }
  for (const key of drop) {
    text = text.replace(new RegExp(`\\{[^{}]*"homematic_name":"${key}"[^{}]*\\},?\\n`), '');
  }
  if (extra.length) {
    text = text.replace(
      '"vars":[\n',
      `"vars":[\n${extra.map((e) => `${JSON.stringify(e)},`).join('\n')}\n`,
    );
  }
  return text;
}

/** Timers driven by the test: advance(ms) fires the due ones in time order. */
export function fakeClock(start = 0) {
  const clock = { t: start };
  let next = 0;
  const list = new Map();
  const add = (fn, ms, every) => {
    next += 1;
    list.set(next, { fn, at: clock.t + Math.max(0, ms), every });
    return next;
  };
  const timers = {
    setTimeout: (fn, ms) => add(fn, ms),
    clearTimeout: (h) => list.delete(h),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: (h) => list.delete(h),
  };
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  };
  return {
    clock,
    timers,
    now: () => WALL0 + clock.t,
    mono: () => clock.t,
    settle,
    get size() {
      return list.size;
    },
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        let due;
        for (const [h, e] of list) if (e.at <= end && (!due || e.at < due[1].at)) due = [h, e];
        if (!due) break;
        const [h, e] = due;
        clock.t = Math.max(clock.t, e.at);
        if (e.every) e.at = clock.t + e.every;
        else list.delete(h);
        e.fn();
        await settle();
      }
      clock.t = end;
      await settle();
    },
  };
}

export class FakeChannel extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.secret = options.token;
    this.started = false;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  up() {
    this.emit('up', {});
  }
  telegram(body, { from = '192.168.1.50', at, boot, seq } = {}) {
    this.emit('message', { type: 'telegram', from, at, boot, seq, body });
  }
}

export const RUNNING = [
  {
    name: RECEIVER.name,
    status: 'running',
    ports: [
      { name: RECEIVER.tcpPortName, container_port: 8189, protocol: 'tcp', host_port: 40189 },
    ],
  },
];

export async function makeApp({
  config = {},
  devices = [],
  store = memoryStore(),
  containers = RUNNING,
  connect = true,
} = {}) {
  const time = fakeClock();
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices, containers });
  const channels = [];
  const lines = [];
  const logger = {
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    debug: () => {},
  };
  const app = new WiffiApp({
    gladys,
    logger,
    store,
    now: time.now,
    clock: time.mono,
    timers: time.timers,
    createChannel: (options) => {
      const channel = new FakeChannel(options);
      channels.push(channel);
      return channel;
    },
  });
  registerHandlers(gladys, app, logger);
  const env = {
    app,
    gladys,
    store,
    time,
    lines,
    channels,
    get channel() {
      return channels.at(-1);
    },
    /** A telegram received now (dated now unless `age` ms in the past). */
    async send(body, { from = '192.168.1.50', age = 0, seq, boot = BOOT } = {}) {
      env.seq += 1;
      env.channel.telegram(body, {
        from,
        at: new Date(time.now() - age).toISOString(),
        boot,
        seq: seq ?? env.seq,
      });
      await time.settle();
    },
    seq: 0,
    states(id) {
      return gladys.fake.states.filter((s) => s.device_feature_external_id === id);
    },
    status() {
      return gladys.fake.connectionStatus;
    },
    async stop() {
      await app.stop();
      await gladys.disconnect?.();
    },
  };
  if (connect) {
    await gladys.connect();
    await time.settle();
    env.channel?.up();
    await time.settle();
  }
  return env;
}

/** The discovered device of the Wiffi, created in Gladys as the user would. */
export async function createDevice(env, mac = MAC) {
  const device = env.gladys.fake.discoveredDevices.find(
    (d) => d.external_id === `ext:${SELECTOR}:wiffi:${mac}`,
  );
  if (!device) throw new Error('not discovered');
  await env.gladys.fake.deviceCreated(device);
  await env.time.settle();
  return device;
}
