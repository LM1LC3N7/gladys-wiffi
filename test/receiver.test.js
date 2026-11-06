// -----------------------------------------------------------------------------
// The real receiver on the loopback, with the real channel client: what
// reaches the main container, and every bound (source, size, connections,
// time, rate). Every wait is bounded; every server closed in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { ChannelClient } from '../src/channel.js';
import { LIMITS } from '../src/constants.js';
import { allowedOf, createFramer, startReceiver } from '../src/push/service.js';
import { WEATHERMAN } from './helpers/app.js';

const TOKEN = 'c'.repeat(32);

const within = (ms, what) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms).unref());

async function setup(t, env = {}) {
  const service = await startReceiver({
    env: {
      CHANNEL_TOKEN: TOKEN,
      TCP_PORT: '0',
      CHANNEL_PORT: '0',
      TCP_HOST: '127.0.0.1',
      ALLOWED: '',
      ...env,
    },
  });
  const client = new ChannelClient({ host: '127.0.0.1', port: service.channel.port, token: TOKEN });
  const messages = [];
  client.on('message', (m) => messages.push(m));
  const up = once(client, 'up');
  client.start();
  await Promise.race([up, within(5000, 'channel up')]);
  t.after(async () => {
    client.stop();
    await service.stop();
  });
  const until = async (fn, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const open = (localAddress) =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: service.port, localAddress }, () =>
        resolve(socket),
      );
      socket.on('error', () => {});
      socket.once('error', reject);
    });
  const closed = (socket, ms = 5000) =>
    socket.destroyed || socket.readyState === 'closed'
      ? Promise.resolve()
      : Promise.race([new Promise((r) => socket.once('close', r)), within(ms, 'socket closed')]);
  return { service, messages, until, open, closed };
}

test('framer: ends on 0x04 or 0x03, at the end of the stream, cut over the bound', () => {
  const frames = [];
  let oversize = 0;
  const framer = createFramer({
    max: 20,
    onFrame: (t) => frames.push(t),
    onOversize: () => (oversize += 1),
  });
  assert.equal(framer.data(Buffer.from('{"a"')), true);
  assert.equal(framer.data(Buffer.from(':1}\x04\n{"b":2}\x03  \x04{"c"')), true);
  framer.end();
  assert.deepEqual(frames, ['{"a":1}', '\n{"b":2}', '{"c"']);
  const cut = createFramer({
    max: 20,
    onFrame: (t) => frames.push(t),
    onOversize: () => (oversize += 1),
  });
  assert.equal(cut.data(Buffer.alloc(15, 0x41)), true);
  assert.equal(cut.data(Buffer.alloc(6, 0x41)), false, 'cut as soon as the bound is passed');
  assert.equal(oversize, 1);
  assert.equal(cut.data(Buffer.from('\x04')), false);
  cut.end();
  assert.equal(frames.length, 3, 'nothing of the cut telegram');
  const ended = createFramer({
    max: 20,
    onFrame: (t) => frames.push(t),
    onOversize: () => (oversize += 1),
  });
  assert.equal(
    ended.data(Buffer.from(`${'A'.repeat(25)}\x04`)),
    false,
    'over the bound even with its end',
  );
  assert.equal(frames.length, 3);
  assert.equal(oversize, 2);
});

test('ALLOWED: empty = private, a list, none for an invalid list', () => {
  assert.deepEqual(allowedOf(''), []);
  assert.deepEqual(allowedOf('192.168.1.5,10.0.0.0/24'), ['192.168.1.5', '10.0.0.0/24']);
  assert.equal(allowedOf('none'), null);
  assert.equal(allowedOf('192.168.1.5,wiffi'), null);
});

test('a telegram ended by 0x04 reaches the main container, dated, with its source', async (t) => {
  const s = await setup(t);
  const socket = await s.open();
  socket.write(WEATHERMAN.slice(0, 100));
  socket.write(`${WEATHERMAN.slice(100)}\x04`);
  await s.until(() => s.messages.length === 1, 'telegram');
  const [m] = s.messages;
  assert.equal(m.type, 'telegram');
  assert.equal(m.from, '127.0.0.1');
  assert.equal(m.body, WEATHERMAN);
  assert.ok(Math.abs(Date.parse(m.at) - Date.now()) < 5000);
  assert.match(m.boot, /^[0-9a-f]{16}$/);
  assert.equal(m.seq, 1);
  socket.end();
  // Without the end byte: read when the Wiffi closes.
  const other = await s.open();
  other.end(WEATHERMAN);
  await s.until(() => s.messages.length === 2, 'telegram without 0x04');
});

test('a sender not allowed is closed before a byte is read; no one when invalid', async (t) => {
  const s = await setup(t, { ALLOWED: '192.168.1.50' });
  const socket = await s.open();
  socket.write(`${WEATHERMAN}\x04`);
  await s.closed(socket);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    s.messages.map((m) => [m.type, m.reason, m.from]),
    [['refused', 'source', '127.0.0.1']],
  );
  const none = await setup(t, { ALLOWED: 'none' });
  const again = await none.open();
  again.write(`${WEATHERMAN}\x04`);
  await none.closed(again);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(none.messages.filter((m) => m.type === 'telegram').length, 0);
});

test('over 64 KB without an end: cut before the end, nothing forwarded', async (t) => {
  const s = await setup(t);
  const socket = await s.open();
  let sent = 0;
  const chunk = Buffer.alloc(16 * 1024, 0x20);
  // Up to 1 MB in 16 KB steps, stopping as soon as the receiver closes.
  while (sent < 1024 * 1024 && !socket.destroyed) {
    socket.write(chunk);
    sent += chunk.length;
    await new Promise((r) => setTimeout(r, 10));
  }
  await s.closed(socket);
  assert.ok(sent <= 256 * 1024, `closed soon after 64 KB (${sent} bytes sent)`);
  await s.until(() => s.messages.some((m) => m.reason === 'size'), 'size notice');
  assert.equal(s.messages.filter((m) => m.type === 'telegram').length, 0);
});

test('a silent connection is closed after the idle time; a slow one after its life', async (t) => {
  const s = await setup(t, { IDLE_MS: '200', LIFE_MS: '700' });
  const silent = await s.open();
  const started = Date.now();
  await s.closed(silent, 3000);
  assert.ok(Date.now() - started < 600);
  // Silent after a first byte: the idle time again, not the whole life.
  const paused = await s.open();
  paused.write('{');
  const after = Date.now();
  await s.closed(paused, 3000);
  assert.ok(Date.now() - after < 600, `closed after ${Date.now() - after} ms`);
  const slow = await s.open();
  const timer = setInterval(() => slow.destroyed || slow.write(' '), 100);
  t.after(() => clearInterval(timer));
  const begun = Date.now();
  await s.closed(slow, 3000);
  clearInterval(timer);
  assert.ok(Date.now() - begun >= 600, 'kept while it sends');
  assert.ok(Date.now() - begun < 2000, 'but not beyond its life');
});

test('connections: 4 per source, the oldest of the source goes; 4 telegrams per connection', async (t) => {
  const s = await setup(t);
  const sockets = [];
  for (let i = 0; i < LIMITS.connectionsPerSource + 1; i += 1) sockets.push(await s.open());
  await s.closed(sockets[0]);
  assert.equal(
    sockets.slice(1).some((x) => x.destroyed),
    false,
  );
  await s.until(() => s.service.connections === LIMITS.connectionsPerSource, 'four open');
  // The newest still delivers.
  sockets.at(-1).write(`${WEATHERMAN}\x04`);
  await s.until(() => s.messages.some((m) => m.type === 'telegram'), 'newest delivers');
  const busy = sockets[1];
  busy.write(`${WEATHERMAN}\x04`.repeat(6));
  await s.closed(busy);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    s.messages.filter((m) => m.type === 'telegram').length,
    1 + LIMITS.telegramsPerConnection,
  );
  for (const x of sockets) x.destroy();
});

test('rate: 60 telegrams a minute per source, then dropped and told', async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 20; i += 1) {
    const socket = await s.open();
    socket.end(`${WEATHERMAN}\x04${WEATHERMAN}\x04${WEATHERMAN}\x04${WEATHERMAN}\x04`);
    await s.closed(socket);
  }
  await s.until(() => s.messages.some((m) => m.reason === 'rate'), 'rate notice');
  assert.equal(s.messages.filter((m) => m.type === 'telegram').length, LIMITS.telegramsPerSource);
});

test('kept while the main container is away, bounded, then delivered in order', async (t) => {
  const service = await startReceiver({
    env: {
      CHANNEL_TOKEN: TOKEN,
      TCP_PORT: '0',
      CHANNEL_PORT: '0',
      TCP_HOST: '127.0.0.1',
      ALLOWED: '',
    },
  });
  t.after(() => service.stop());
  for (let i = 0; i < 3; i += 1) {
    const socket = await new Promise((resolve) => {
      const x = connect({ host: '127.0.0.1', port: service.port }, () => resolve(x));
    });
    socket.end(`${WEATHERMAN.replace('12.4', `1${i}.0`)}\x04`);
    await once(socket, 'close');
  }
  const client = new ChannelClient({ host: '127.0.0.1', port: service.channel.port, token: TOKEN });
  t.after(() => client.stop());
  const got = [];
  client.on('message', (m) => got.push(m));
  client.start();
  const end = Date.now() + 5000;
  while (got.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    got.map((m) => m.body.match(/"value":"(1\d\.0)"/)[1]),
    ['10.0', '11.0', '12.0'],
  );
  assert.deepEqual(
    got.map((m) => m.seq),
    [1, 2, 3],
  );
});

test('16 connections in all: the oldest silent one makes room, never one mid-telegram', async (t) => {
  const s = await setup(t);
  const sockets = [];
  for (let source = 1; source <= 4; source += 1) {
    for (let i = 0; i < LIMITS.connectionsPerSource; i += 1)
      sockets.push(await s.open(`127.0.0.${source}`));
  }
  await s.until(() => s.service.connections === LIMITS.connections, 'sixteen open');
  // The oldest one has started a telegram: it is not the one closed.
  sockets[0].write('{"modultyp":');
  await new Promise((r) => setTimeout(r, 50));
  const newcomer = await s.open('127.0.0.9');
  await s.closed(sockets[1]);
  assert.equal(sockets[0].destroyed, false, 'mid-telegram kept');
  assert.equal(newcomer.destroyed, false);
  newcomer.end(`${WEATHERMAN}\x04`);
  await s.until(
    () => s.messages.some((m) => m.type === 'telegram' && m.from === '127.0.0.9'),
    'newcomer',
  );
  for (const x of sockets) x.destroy();
});
