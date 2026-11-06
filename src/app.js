// -----------------------------------------------------------------------------
// The integration: the Wiffis of the network, read only, through the JSON
// telegrams they send to the `wiffi-push` sub-container.
//
//   - Reception: the receiver checks the source address, the size, the
//     connections and the rate (src/push/service.js) and hands each
//     telegram, dated when it arrived, over the channel. This container
//     checks the source address again, reads the telegram strictly
//     (src/telegram.js) and keys the Wiffi by its MAC address.
//   - States: a value is published only when it is a valid measurement of a
//     supported unit within its range (src/model.js); otherwise nothing is
//     published for it (never a 0 or a guess). A telegram older than the
//     last one applied for that Wiffi is ignored; one received more than a
//     minute ago is published with its date; more than 2 h ago, never.
//   - Silence: a Wiffi that sent nothing for the configured delay is shown
//     unreachable (transport badge) and named in the status; a sensor that
//     gave no valid value for that delay while its Wiffi talks is named too.
//     Decided on the monotonic clock; the wall clock only dates the
//     telegrams and, at start, what /data says of the last telegram.
//   - /data: the Wiffis and their features, so nothing is lost at a
//     restart. Unreadable: never written over, read again every 10 s.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLogger } from '@gladysassistant/integration-sdk';
import { ChannelClient } from './channel.js';
import { TOKEN_KEY, isAllowed, isToken, normalizeConfig } from './config.js';
import { ID_TYPE, LIMITS, MINUTE, RECEIVER, TIMINGS } from './constants.js';
import { buildStatus } from './i18n.js';
import { buildDevice, describe, idsOf, sameSpec, stateOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory, serializeMemory } from './store.js';
import { formatMac, parseTelegram } from './telegram.js';

const newToken = () => randomBytes(24).toString('base64url');

/** The order of a telegram in its receiver process, or null. */
function orderOf(message) {
  const { boot, seq } = message;
  return typeof boot === 'string' &&
    /^[0-9a-f]{16}$/.test(boot) &&
    Number.isSafeInteger(seq) &&
    seq > 0
    ? { boot, seq }
    : null;
}

/** Refusals shown in the status for an hour after the last one. */
const REFUSED_SHOWN = 60 * MINUTE;

export class WiffiApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'wiffi' }),
    store = fileStore(),
    now = Date.now,
    clock = () => performance.now(),
    timers = globalThis,
    createChannel = (options) => new ChannelClient(options),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.createChannel = createChannel;
    this.config = normalizeConfig();
    this.started = false;
    this.stopped = false;
    this.generation = 0;
    this.memory = emptyMemory();
    /** Whether /data was read (or found empty): only then is it written. */
    this.loaded = false;
    this.unreadable = false;
    this.loading = undefined;
    this.token = undefined;
    this.receiver = { status: 'not started', port: null };
    this.lastReceiverTry = -Infinity;
    this.lastReceiverEnv = undefined;
    this.channel = undefined;
    this.channelUp = false;
    this.configAttempt = 0;
    this.timersById = {};
    /** name -> monotonic time a soon() run is due */
    this.dueAt = {};
    this.tickTimer = undefined;
    this.startMono = this.clock();
    /** mac -> monotonic time its last telegram arrived */
    this.heard = new Map();
    /** mac -> { boot, seq } of its last telegram applied: the order */
    this.lastOrder = new Map();
    /** featureId -> monotonic time of its last valid value */
    this.valid = new Map();
    /** featureId -> { value, at } its last valid value (republished when the device is created) */
    this.lastValues = new Map();
    /** mac -> keys whose unit changed (not published) */
    this.changed = new Map();
    this.unsupported = new Set();
    this.refused = {};
    this.created = new Map();
    this.transports = new Map();
    this.lastStatus = undefined;
    this.publisher = new StatePublisher({ gladys, logger, now, clock, timers });
  }

  ids(mac) {
    return idsOf((type, id) => this.gladys.externalIds(type, id), mac);
  }

  // --- Timers ------------------------------------------------------------------

  later(name, delay, fn) {
    this.timers.clearTimeout(this.timersById[name]);
    const generation = this.generation;
    this.timersById[name] = this.timers.setTimeout(() => {
      this.timersById[name] = undefined;
      if (generation === this.generation && !this.stopped) {
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
      }
    }, delay);
  }

  /** Like later(), but when a run is already planned, the earliest of the two is kept. */
  soon(name, delay, fn) {
    const due = this.clock() + delay;
    if (this.timersById[name] && this.dueAt[name] <= due) return;
    this.dueAt[name] = due;
    this.later(name, delay, fn);
  }

  clearTimers() {
    for (const id of Object.values(this.timersById)) this.timers.clearTimeout(id);
    this.timersById = {};
    if (this.tickTimer) {
      this.timers.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Gladys (re)connected: the configuration, read again without end until it answers. */
  async gladysConnected() {
    if (this.stopped) return;
    this.timers.clearTimeout(this.timersById.config);
    this.timersById.config = undefined;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      const delays = TIMINGS.configRetry;
      const delay = delays[Math.min(this.configAttempt, delays.length - 1)];
      this.configAttempt += 1;
      this.logger.warn(
        `Reading the configuration failed (${err.message}): again in ${delay / 1000} s`,
      );
      await this.setStatus(false, {
        en: `The configuration could not be read from Gladys; tried again in ${delay / 1000} s.`,
        fr: `La configuration n’a pas pu être lue dans Gladys ; nouvel essai dans ${delay / 1000} s.`,
      });
      this.timersById.config = this.timers.setTimeout(() => {
        this.timersById.config = undefined;
        this.gladysConnected().catch((e) => this.logger.error(`Start failed: ${e.message}`));
      }, delay);
      return;
    }
    this.configAttempt = 0;
    await this.apply(raw, { reconnected: true });
  }

  /** Saved by the user: applied at once (the receiver takes the new senders). */
  async configUpdated(raw) {
    if (this.stopped) return;
    await this.apply(raw ?? {}, { reconnected: false });
  }

  /** One configuration applied at a time, in the order they came: the last one wins. */
  apply(raw, options) {
    const run = (this.applying ?? Promise.resolve()).then(() => {
      if (!this.stopped) return this.applyNow(raw, options);
      return undefined;
    });
    this.applying = run.catch(() => {});
    return run;
  }

  async applyNow(raw, { reconnected }) {
    this.config = normalizeConfig(raw);
    if (!this.started) {
      this.started = true;
      this.startMono = this.clock();
      this.publisher.start();
      this.tickTimer = this.timers.setInterval(() => {
        this.tick().catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
      }, TIMINGS.tick);
      // Not awaited beyond its own bound: telegrams are taken meanwhile.
      await this.loadMemory();
    }
    if (reconnected) {
      // Gladys keeps the status, the Discovery and the badges in memory only.
      this.lastStatus = undefined;
      this.transports.clear();
      this.gladys.forgetPublishedStates?.();
    }
    this.refreshCreated();
    await this.ensureToken(raw);
    await this.ensureReceiver();
    await this.publishDiscovery();
    await this.publishTransports();
    await this.updateStatus();
  }

  /** Clean stop: timers off, the channel closed, /data written (bounded). */
  async stop() {
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.publisher.stop();
    this.channel?.stop();
    this.channel = undefined;
    if (this.loaded && !this.unreadable) {
      let timer;
      await Promise.race([
        this.store.save(serializeMemory(this.memory)).catch(() => {}),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(resolve, 2000);
        }),
      ]);
      this.timers.clearTimeout(timer);
    }
  }

  /** The secret of the channel: generated once, kept in the Gladys configuration. */
  async ensureToken(raw) {
    const value = raw?.[TOKEN_KEY];
    if (isToken(value)) {
      this.token = value;
      return;
    }
    if (!isToken(this.token)) this.token = newToken();
    await this.gladys
      .setConfig({ [TOKEN_KEY]: this.token })
      .catch((err) => this.logger.warn(`Keeping the channel secret failed: ${err.message}`));
  }

  // --- /data -------------------------------------------------------------------------

  /** One read at a time; unreadable: read again on a timer of its own, never written over. */
  loadMemory() {
    if (!this.loading) {
      this.loading = this.readMemory().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  async readMemory() {
    let raw;
    try {
      raw = await this.store.load();
    } catch (err) {
      if (!this.unreadable) {
        this.logger.error(
          `/data/wiffi.json cannot be read (${err?.code ?? 'invalid'}): kept in memory only`,
        );
      }
      this.unreadable = true;
      this.later('data', TIMINGS.dataRetry, () => this.loadMemory());
      return;
    }
    const wasUnreadable = this.unreadable;
    this.unreadable = false;
    const now = this.now();
    const mono = this.clock();
    const file = normalizeMemory(raw, now);
    // What was learned meanwhile (in RAM) wins over the file; the file adds the rest.
    for (const [mac, entry] of Object.entries(file.devices)) {
      const current = this.memory.devices[mac];
      if (!current) {
        if (Object.keys(this.memory.devices).length >= LIMITS.devices) continue;
        this.memory.devices[mac] = entry;
        if (entry.lastAt > 0 && !this.heard.has(mac)) {
          // Wall clock at start, monotonic since: when it was last heard.
          this.heard.set(mac, mono - Math.max(0, now - entry.lastAt));
        }
        continue;
      }
      for (const [key, spec] of Object.entries(entry.features)) {
        if (
          !current.features[key] &&
          Object.keys(current.features).length < LIMITS.featuresPerDevice
        ) {
          current.features[key] = spec;
        }
      }
    }
    this.loaded = true;
    if (wasUnreadable) {
      this.saveSoon(TIMINGS.saveDelay);
      await this.publishDiscovery();
      await this.updateStatus();
    }
  }

  saveSoon(delay) {
    this.soon('save', delay, () => this.saveMemory());
  }

  async saveMemory() {
    if (!this.loaded || this.unreadable) return false;
    try {
      await this.store.save(serializeMemory(this.memory));
      return true;
    } catch (err) {
      this.logger.warn(`Saving the Wiffis in /data failed: ${err.message}`);
      return false;
    }
  }

  // --- Receiver -----------------------------------------------------------------------

  receiverEnv() {
    return {
      CHANNEL_TOKEN: this.token,
      TCP_PORT: String(RECEIVER.tcpPort),
      CHANNEL_PORT: String(RECEIVER.channelPort),
      // An invalid list never falls back to "private addresses": no one.
      ALLOWED: this.config.problem ? 'none' : this.config.allowed.join(','),
    };
  }

  /** Starts the receiver with the current env (Gladys recreates it when the env changed). */
  async ensureReceiver() {
    this.lastReceiverTry = this.clock();
    const generation = this.generation;
    const env = this.receiverEnv();
    const envKey = JSON.stringify(env);
    try {
      await this.gladys.startContainer(RECEIVER.name, { env });
      if (generation !== this.generation) return;
      this.lastReceiverEnv = envKey;
      const containers = await this.gladys.getContainers();
      if (generation !== this.generation) return;
      const container = (Array.isArray(containers) ? containers : []).find(
        (c) => c?.name === RECEIVER.name,
      );
      const port = container?.ports?.find((p) => p?.name === RECEIVER.tcpPortName)?.host_port;
      this.receiver = {
        status: typeof container?.status === 'string' ? container.status.slice(0, 40) : 'unknown',
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      };
    } catch (err) {
      if (generation !== this.generation) return;
      this.receiver = { status: 'error', port: null };
      this.logger.warn(`Could not start the Wiffi receiver: ${err.message}`);
      return;
    }
    if (this.receiver.status === 'running') {
      this.startChannel();
    }
  }

  startChannel() {
    if (this.channel && this.channel.secret === this.token) return;
    this.channel?.stop();
    const generation = this.generation;
    const channel = this.createChannel({
      host: RECEIVER.name,
      port: RECEIVER.channelPort,
      token: this.token,
      logger: this.logger,
    });
    this.channel = channel;
    this.channelUp = false;
    channel.on('up', () => {
      if (this.channel !== channel) return;
      this.channelUp = true;
      this.logger.info('Connected to the Wiffi receiver');
      this.statusSoon();
    });
    channel.on('down', () => {
      if (this.channel !== channel) return;
      this.channelUp = false;
      this.logger.warn('Lost the Wiffi receiver, reconnecting');
      this.statusSoon();
    });
    channel.on('message', (message) => {
      if (generation !== this.generation || this.channel !== channel) return;
      try {
        if (message?.type === 'telegram') this.onTelegram(message);
        else if (message?.type === 'refused') this.onRefused(message);
      } catch (err) {
        // A telegram that breaks something never stops the others.
        this.logger.warn(`A telegram was ignored: ${err.message}`);
      }
    });
    channel.start();
  }

  // --- Telegrams -------------------------------------------------------------------------

  countRefused(reason, from = '') {
    const entry = this.refused[reason] ?? { count: 0, from: '', last: -Infinity };
    entry.count = Math.min(entry.count + 1, 1e9);
    entry.from = typeof from === 'string' && from.length <= 64 ? from : '';
    entry.last = this.clock();
    this.refused[reason] = entry;
    this.statusSoon();
  }

  onRefused(message) {
    const reasons = ['source', 'size', 'rate', 'total', 'connections'];
    if (!reasons.includes(message.reason)) return;
    this.countRefused(message.reason, typeof message.from === 'string' ? message.from : '');
  }

  noteUnsupported(metric) {
    if (this.unsupported.size >= 50) return;
    const label = `${metric.key} (${metric.unit || metric.kind})`;
    if (!this.unsupported.has(label)) {
      this.unsupported.add(label);
      this.statusSoon();
    }
  }

  onTelegram(message) {
    const { from, at, body } = message;
    if (typeof from !== 'string' || typeof at !== 'string' || typeof body !== 'string') return;
    // One reading of each clock for the whole decision.
    const now = this.now();
    const mono = this.clock();
    let sent = Date.parse(at);
    if (!Number.isFinite(sent)) return;
    // Dated by the receiver (same machine): never in the future.
    sent = Math.min(sent, now);
    const age = now - sent;
    if (age > TIMINGS.maxAge) {
      this.countRefused('stale', from);
      return;
    }
    if (this.config.problem || !isAllowed(from, this.config.allowed)) {
      this.countRefused('source', from);
      return;
    }
    const parsed = parseTelegram(body);
    if (parsed.error) {
      this.countRefused(parsed.error === 'empty' ? 'json' : parsed.error, from);
      return;
    }
    const { mac } = parsed;
    let entry = this.memory.devices[mac];
    let structure = false;
    if (!entry) {
      // A Wiffi is remembered only with something to publish: a telegram of
      // unknown variables never takes a place in the table (nor in /data).
      if (!parsed.metrics.some((metric) => describe(metric).spec)) {
        for (const metric of parsed.metrics) {
          if (describe(metric).skip === 'unit') this.noteUnsupported(metric);
        }
        this.countRefused('nothing', from);
        return;
      }
      if (Object.keys(this.memory.devices).length >= LIMITS.devices && !this.evictOne()) {
        this.countRefused('devices', from);
        return;
      }
      entry = {
        model: parsed.model,
        firmware: parsed.firmware,
        address: from,
        lastAt: 0,
        features: {},
      };
      this.memory.devices[mac] = entry;
      structure = true;
      this.logger.info(`New Wiffi ${parsed.model} ${formatMac(mac)} at ${from}`);
    }
    // Order: the number the receiver gave it (a wall clock that steps back never
    // blocks the telegrams); from another receiver process, the arrival order.
    const order = orderOf(message);
    const previous = this.lastOrder.get(mac);
    if (order && previous && order.boot === previous.boot && order.seq <= previous.seq) {
      this.countRefused('order', from);
      return;
    }
    if (order) this.lastOrder.set(mac, order);
    if (
      entry.model !== parsed.model ||
      entry.firmware !== parsed.firmware ||
      entry.address !== from
    ) {
      entry.model = parsed.model;
      entry.firmware = parsed.firmware;
      entry.address = from;
      structure = true;
    }
    entry.lastAt = sent;
    const heardAt = mono - age;
    const wasAlive = this.isAlive(mac, mono);
    this.heard.set(mac, Math.max(this.heard.get(mac) ?? -Infinity, heardAt));
    const ids = this.ids(mac);
    const created = this.created.has(ids.device);
    const changed = this.changed.get(mac) ?? new Set();
    for (const metric of parsed.metrics) {
      const described = describe(metric);
      let spec = entry.features[metric.key];
      if (spec && !sameSpec(spec, described.spec)) {
        // Another unit (or kind) under the same name: never published into the old feature.
        if (changed.size < 50) changed.add(metric.key);
        continue;
      }
      if (described.skip) {
        if (described.skip === 'unit') this.noteUnsupported(metric);
        continue;
      }
      if (!spec) {
        if (Object.keys(entry.features).length >= LIMITS.featuresPerDevice) {
          this.noteUnsupported({ ...metric, unit: 'limit' });
          continue;
        }
        spec = { ...described.spec, name: metric.desc || metric.key };
        entry.features[metric.key] = spec;
        structure = true;
      }
      changed.delete(metric.key);
      const state = stateOf(spec, metric.value);
      if (!state) continue;
      const featureId = ids.feature(metric.key);
      this.valid.set(featureId, Math.max(this.valid.get(featureId) ?? -Infinity, heardAt));
      this.lastValues.set(featureId, { value: state, at: sent });
      if (created) this.publisher.push(featureId, state, sent);
    }
    if (changed.size > 0) this.changed.set(mac, changed);
    else this.changed.delete(mac);
    if (structure) {
      this.soon('discovery', TIMINGS.discoveryDelay, () => this.publishDiscovery());
      this.saveSoon(TIMINGS.saveDelay);
    } else {
      // Only the time of the last telegram changed: written seldom.
      this.saveSoon(10 * MINUTE);
    }
    if (!wasAlive && created) {
      this.publishTransports().catch(() => {});
    }
    this.statusSoon();
  }

  // --- The table of the Wiffis ------------------------------------------------------------------

  /** When a Wiffi was last heard (monotonic), -Infinity when never since the start. */
  lastHeard(mac) {
    return this.heard.get(mac) ?? -Infinity;
  }

  /**
   * The table is full: the Wiffi not created in Gladys heard the longest ago
   * makes room. A Wiffi created in Gladys is never pushed out by another one.
   * @returns {boolean} whether a place was freed.
   */
  evictOne() {
    let oldest;
    for (const mac of Object.keys(this.memory.devices)) {
      if (this.created.has(this.ids(mac).device)) continue;
      if (oldest === undefined || this.lastHeard(mac) < this.lastHeard(oldest)) oldest = mac;
    }
    if (oldest === undefined) return false;
    this.forgetWiffi(oldest);
    return true;
  }

  /** Wiffis never created in Gladys and not heard for a day: forgotten (memory and /data). */
  purgeForgotten(mono = this.clock()) {
    let removed = false;
    for (const mac of Object.keys(this.memory.devices)) {
      if (this.created.has(this.ids(mac).device)) continue;
      const heard = this.heard.get(mac) ?? this.startMono;
      if (mono - heard >= TIMINGS.forgetAfter) {
        this.forgetWiffi(mac);
        removed = true;
      }
    }
    return removed;
  }

  forgetWiffi(mac) {
    const entry = this.memory.devices[mac];
    if (!entry) return;
    const ids = this.ids(mac);
    for (const key of Object.keys(entry.features)) {
      this.valid.delete(ids.feature(key));
      this.lastValues.delete(ids.feature(key));
    }
    delete this.memory.devices[mac];
    this.heard.delete(mac);
    this.lastOrder.delete(mac);
    this.changed.delete(mac);
    this.logger.info(`Wiffi ${formatMac(mac)} forgotten (never created in Gladys)`);
    this.soon('discovery', TIMINGS.discoveryDelay, () => this.publishDiscovery());
    this.saveSoon(TIMINGS.saveDelay);
  }

  // --- Silence -------------------------------------------------------------------------------

  silenceMs() {
    return this.config.silenceMinutes * MINUTE;
  }

  isAlive(mac, mono = this.clock()) {
    const heard = this.heard.get(mac);
    return heard !== undefined && mono - heard < this.silenceMs();
  }

  /** Features of a talking Wiffi without a valid value for the silence delay. */
  muteOf(mac, entry, mono) {
    const ids = this.ids(mac);
    const mute = [];
    for (const key of Object.keys(entry.features)) {
      const valid = this.valid.get(ids.feature(key)) ?? this.startMono;
      if (mono - valid >= this.silenceMs()) mute.push(key);
    }
    return mute;
  }

  // --- Gladys --------------------------------------------------------------------------------

  /** The Wiffi devices created in Gladys, by external id. */
  refreshCreated() {
    this.created = new Map();
    // `ext:<selector>:wiffi:`: the devices of this integration.
    const prefix = this.gladys.externalIds(ID_TYPE, 'x').device.slice(0, -1);
    for (const device of this.gladys.devices ?? []) {
      const id = device?.external_id;
      if (typeof id === 'string' && id.startsWith(prefix)) {
        this.created.set(id, device);
      }
    }
  }

  async deviceCreated() {
    this.refreshCreated();
    // The values Gladys dropped before the device existed: the recent ones
    // again, with their date when they are not new (the publisher dates them).
    const mono = this.clock();
    for (const [mac, entry] of Object.entries(this.memory.devices)) {
      const ids = this.ids(mac);
      if (!this.created.has(ids.device)) continue;
      for (const key of Object.keys(entry.features)) {
        const featureId = ids.feature(key);
        const last = this.lastValues.get(featureId);
        const valid = this.valid.get(featureId);
        if (last && valid !== undefined && mono - valid < this.silenceMs()) {
          this.publisher.push(featureId, last.value, last.at);
        }
      }
    }
    await this.publishTransports();
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (typeof device?.external_id === 'string') this.transports.delete(device.external_id);
  }

  async scan() {
    await this.publishDiscovery();
  }

  async publishDiscovery() {
    // A Wiffi without any feature is never offered (nothing to create).
    const devices = Object.entries(this.memory.devices)
      .filter(([, entry]) => Object.keys(entry.features).length > 0)
      .map(([mac, entry]) =>
        buildDevice(
          (type, id) => this.gladys.externalIds(type, id),
          mac,
          entry,
          this.created.get(this.ids(mac).device),
        ),
      );
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn(`Publishing the Discovery failed: ${err.message}`);
    }
  }

  /** The transport badge of each created Wiffi: local while it talks, unreachable when silent. */
  async publishTransports() {
    const mono = this.clock();
    const changes = [];
    for (const mac of Object.keys(this.memory.devices)) {
      const id = this.ids(mac).device;
      if (!this.created.has(id)) continue;
      const transport = this.isAlive(mac, mono) ? 'local' : 'unreachable';
      if (this.transports.get(id) !== transport) {
        changes.push({ external_id: id, transport });
      }
    }
    if (changes.length === 0) return;
    try {
      await this.gladys.publishTransports(changes);
      for (const change of changes) this.transports.set(change.external_id, change.transport);
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  // --- Status and background ---------------------------------------------------------------

  statusSoon() {
    this.soon('status', 1000, () => this.updateStatus());
  }

  snapshot(mono = this.clock()) {
    const devices = Object.entries(this.memory.devices).map(([mac, entry]) => {
      const heard = this.heard.get(mac);
      const alive = this.isAlive(mac, mono);
      return {
        label: `${entry.model} ${formatMac(mac)}`,
        alive,
        silentMinutes: heard === undefined ? null : Math.floor((mono - heard) / MINUTE),
        mute: alive ? this.muteOf(mac, entry, mono) : [],
        changed: [...(this.changed.get(mac) ?? [])],
      };
    });
    const refused = {};
    for (const [reason, entry] of Object.entries(this.refused)) {
      if (mono - entry.last < REFUSED_SHOWN) refused[reason] = entry;
    }
    return {
      problem: this.config.problem,
      unreadable: this.unreadable,
      receiver: this.receiver,
      channelUp: this.channelUp,
      devices,
      refused,
      unsupported: [...this.unsupported],
      silenceMinutes: this.config.silenceMinutes,
    };
  }

  async updateStatus() {
    if (!this.started || this.stopped) return;
    const { connected, message } = buildStatus(this.snapshot());
    await this.setStatus(connected, message);
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    const generation = this.generation;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      if (generation === this.generation) this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Setting the status failed: ${err.message}`);
    }
  }

  async tick() {
    if (!this.started || this.stopped) return;
    if (
      (this.receiver.status !== 'running' ||
        this.lastReceiverEnv !== JSON.stringify(this.receiverEnv())) &&
      this.clock() - this.lastReceiverTry >= TIMINGS.receiverRetry
    ) {
      await this.ensureReceiver();
    }
    if (this.purgeForgotten()) this.statusSoon();
    await this.publishTransports();
    await this.updateStatus();
  }
}
