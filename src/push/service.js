// -----------------------------------------------------------------------------
// The service of the `wiffi-push` sub-container: the TCP port the Wiffis send
// their JSON telegrams to ("send_json" port of the device), and the channel
// that hands each telegram to the main container. The main container cannot
// publish a port; this container does (Gladys picks the host port).
//
// A Wiffi opens a connection, sends one telegram ended by 0x04, and closes
// (wiffi 1.1.2, observed with weatherman firmware 107). Here, bounded for a
// 64 MB container, everything checked before a telegram leaves:
//   - the source address: in the allowed list (env ALLOWED), or private
//     when the list is empty, or none at all when the list is invalid
//     (ALLOWED=none); any other is closed at once, before a byte is read;
//   - 16 connections at most, 4 per source address: over the limit of its
//     source, the oldest connection of that source is closed; over the
//     total, the oldest that has sent nothing, else the oldest that has not
//     sent a whole telegram, else the newcomer;
//   - a connection is closed after 5 s without a byte and after 15 s in
//     all, after 4 telegrams;
//   - a telegram is cut at 64 KB without its end (the connection closed,
//     nothing forwarded); the end is 0x04 (0x03 accepted too), or the end
//     of the connection;
//   - 240 telegrams a minute in all, 60 per source address: beyond, dropped.
// Each refusal is told to the main container (at most every 10 s per
// reason), with the source address only, never the content. Each telegram
// carries the wall time it arrived (its date) and its number in this process
// (`boot`, `seq`: its order, whatever the wall clock does). Limits and
// windows run on the monotonic clock.
//
// Environment, set by the main container through startContainer:
//   CHANNEL_TOKEN  the secret the main container says hello with
//   TCP_PORT       8189 (published by Gladys)
//   CHANNEL_PORT   7778 (private network only)
//   ALLOWED        the allowed senders ('' = private addresses, 'none' = no one)
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createChannelServer } from '../channel.js';
import { LIMITS, RECEIVER, TIMINGS } from '../constants.js';
import { isAllowed, normalizeIp, parseAllowed } from '../config.js';

const END = 0x04;
const END_OLD = 0x03;

function nextEnd(chunk, start) {
  const a = chunk.indexOf(END, start);
  const b = chunk.indexOf(END_OLD, start);
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/**
 * Cuts a byte stream into telegrams. Linear: each chunk is searched once per
 * telegram it ends, the pieces of a telegram are joined once. Over `max`
 * bytes without an end: `onOversize`, and nothing more is read.
 * @returns {{ data(chunk: Buffer): boolean, end(): void }}
 */
export function createFramer({ max = LIMITS.telegramBytes, onFrame, onOversize }) {
  let parts = [];
  let size = 0;
  let dead = false;
  const emit = (buffer) => {
    const text = buffer.toString('utf8');
    if (text.trim() === '') return true;
    return onFrame(text) !== false;
  };
  return {
    data(chunk) {
      if (dead) return false;
      let start = 0;
      let end;
      while ((end = nextEnd(chunk, start)) >= 0) {
        const piece = chunk.subarray(start, end);
        if (size + piece.length > max) {
          dead = true;
          onOversize?.();
          return false;
        }
        parts.push(piece);
        const frame = Buffer.concat(parts, size + piece.length);
        parts = [];
        size = 0;
        start = end + 1;
        if (!emit(frame)) {
          dead = true;
          return false;
        }
      }
      const rest = chunk.subarray(start);
      if (size + rest.length > max) {
        dead = true;
        onOversize?.();
        return false;
      }
      if (rest.length > 0) {
        parts.push(rest);
        size += rest.length;
      }
      return true;
    },
    /** The sender closed: what it sent without an end is a telegram too. */
    end() {
      if (dead || size === 0) return;
      dead = true;
      emit(Buffer.concat(parts, size));
    },
  };
}

/** ALLOWED of the env: the list, or null for "no one". */
export function allowedOf(value) {
  if (value === 'none') return null;
  const parsed = parseAllowed(value ?? '');
  return parsed.error ? null : parsed.list;
}

/**
 * @returns {Promise<{ tcp, channel, stop(): Promise, port: number }>}
 */
export async function startReceiver({
  env = process.env,
  logger,
  now = Date.now,
  clock = () => performance.now(),
} = {}) {
  const allowed = allowedOf(env.ALLOWED);
  const idleMs = Number(env.IDLE_MS ?? TIMINGS.connectionIdle);
  const lifeMs = Number(env.LIFE_MS ?? TIMINGS.connectionLife);
  const channel = createChannelServer({
    port: Number(env.CHANNEL_PORT ?? RECEIVER.channelPort),
    token: env.CHANNEL_TOKEN,
    logger,
    queueSize: LIMITS.queue,
  });
  /** Open connections, oldest first. */
  const conns = new Set();
  let window = [];
  const bySource = new Map();
  const lastNotice = new Map();

  /** This process, and the order of its telegrams: the main container orders by them. */
  const boot = randomBytes(8).toString('hex');
  let seq = 0;

  const notice = (reason, from) => {
    const mono = clock();
    if (mono - (lastNotice.get(reason) ?? -Infinity) < TIMINGS.refusedNotice) return;
    lastNotice.set(reason, mono);
    channel.send(
      { type: 'refused', reason, from, at: new Date(now()).toISOString() },
      { queue: false },
    );
  };

  /** Within the minute budget, in all and for this source. */
  const withinRate = (from, time) => {
    window = window.filter((t) => time - t < 60_000);
    const mine = (bySource.get(from) ?? []).filter((t) => time - t < 60_000);
    if (window.length >= LIMITS.telegramsPerMinute || mine.length >= LIMITS.telegramsPerSource) {
      return false;
    }
    window.push(time);
    mine.push(time);
    if (!bySource.has(from) && bySource.size >= LIMITS.sources) bySource.clear();
    bySource.set(from, mine);
    return true;
  };

  const evict = (which) => {
    for (const socket of conns) {
      if (which(socket)) {
        conns.delete(socket);
        socket.destroy();
        return true;
      }
    }
    return false;
  };

  const tcp = createServer((socket) => {
    const from = normalizeIp(socket.remoteAddress ?? '') ?? '';
    if (allowed === null || !isAllowed(from, allowed)) {
      socket.destroy();
      notice('source', from);
      return;
    }
    const same = (s) => s.wiffiFrom === from;
    let sameCount = 0;
    for (const s of conns) if (same(s)) sameCount += 1;
    if (sameCount >= LIMITS.connectionsPerSource) {
      evict(same);
      notice('connections', from);
    }
    if (
      conns.size >= LIMITS.connections &&
      !evict((s) => s.bytesRead === 0) &&
      !evict((s) => s.wiffiTelegrams === 0)
    ) {
      socket.destroy();
      notice('connections', from);
      return;
    }
    socket.wiffiFrom = from;
    socket.wiffiTelegrams = 0;
    conns.add(socket);
    let idle = setTimeout(() => socket.destroy(), idleMs);
    const life = setTimeout(() => socket.destroy(), lifeMs);
    const framer = createFramer({
      onFrame: (text) => {
        socket.wiffiTelegrams += 1;
        if (!withinRate(from, clock())) {
          notice('rate', from);
        } else {
          seq += 1;
          channel.send({
            type: 'telegram',
            from,
            at: new Date(now()).toISOString(),
            boot,
            seq,
            body: text,
          });
        }
        if (socket.wiffiTelegrams >= LIMITS.telegramsPerConnection) {
          socket.destroy();
          return false;
        }
        return true;
      },
      onOversize: () => notice('size', from),
    });
    socket.on('data', (chunk) => {
      clearTimeout(idle);
      if (!framer.data(chunk)) {
        socket.destroy();
        return;
      }
      idle = setTimeout(() => socket.destroy(), idleMs);
    });
    socket.on('end', () => {
      framer.end();
      socket.end();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(idle);
      clearTimeout(life);
      conns.delete(socket);
    });
  });
  tcp.maxConnections = LIMITS.connections * 4;

  await channel.start();
  await new Promise((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen(Number(env.TCP_PORT ?? RECEIVER.tcpPort), env.TCP_HOST ?? '0.0.0.0', () => {
      tcp.off('error', reject);
      resolve();
    });
  });
  const port = tcp.address().port;
  logger?.info(
    `Wiffi receiver on TCP port ${port} (${allowed === null ? 'no sender allowed' : allowed.length ? `${allowed.length} allowed sender(s)` : 'private addresses'}); channel on port ${channel.port}`,
  );
  return {
    tcp,
    channel,
    port,
    get connections() {
      return conns.size;
    },
    async stop() {
      for (const socket of conns) socket.destroy();
      await new Promise((resolve) => tcp.close(() => resolve()));
      await channel.stop();
    },
  };
}
