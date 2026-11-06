// -----------------------------------------------------------------------------
// Frozen keys, limits and timings, in one place.
// -----------------------------------------------------------------------------

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

/** The receiver of the manifest `containers` (same image, `node src/receiver.js`). */
export const RECEIVER = {
  name: 'wiffi-push',
  /** TCP port the Wiffi sends its JSON telegrams to, published by Gladys on a host port it chooses. */
  tcpPort: 8189,
  tcpPortName: 'wiffi_json',
  /** Channel to the main container, on the private network of the integration only. */
  channelPort: 7778,
};

/** External id type of a Wiffi (the middle part of the device external ids): frozen. */
export const ID_TYPE = 'wiffi';

export const LIMITS = {
  /** A telegram: a weatherman with every sensor is about 10 KB. Cut beyond, before the end. */
  telegramBytes: 64 * 1024,
  /** Open connections of the receiver, in all and per source address. */
  connections: 16,
  connectionsPerSource: 4,
  /** Telegrams read from one connection (the Wiffi sends one, then closes). */
  telegramsPerConnection: 4,
  /** Telegrams accepted per minute by the receiver, in all and per source address. */
  telegramsPerMinute: 240,
  telegramsPerSource: 60,
  /** Source addresses whose minute is counted (beyond, the counters start again). */
  sources: 256,
  /** Telegrams kept by the receiver while the main container is away. */
  queue: 64,
  /** Variables read from one telegram. */
  vars: 200,
  /** A variable name (the feature key), a description, a unit, a text value. */
  keyLength: 64,
  descLength: 60,
  unitLength: 16,
  textLength: 100,
  /** Devices and features per device remembered (and shown in the Discovery). */
  devices: 32,
  featuresPerDevice: 150,
  /** Addresses in the "allowed senders" field. */
  allowedAddresses: 16,
  /** /data/wiffi.json. */
  memoryBytes: 512 * 1024,
  /** Gladys accepts 300 states per minute: a margin is kept. */
  statesPerMinute: 250,
  /** Names listed in the status (silent sensors, unsupported units). */
  statusNames: 6,
  statusLength: 900,
};

export const TIMINGS = {
  /** Connection of the receiver: closed after this long without a byte, and at most this long open. */
  connectionIdle: 5 * SECOND,
  connectionLife: 15 * SECOND,
  /** A refusal of the receiver is told to the main container at most this often (per reason). */
  refusedNotice: 10 * SECOND,
  /** Background round of the main container: silence, status, receiver, /data. */
  tick: 10 * SECOND,
  /** States sent to Gladys every second, within the budget. */
  flushInterval: SECOND,
  /** An unchanged value is sent again this often (Gladys shows when it was last seen). */
  stateHeartbeat: 15 * MINUTE,
  /** A value older than this when it is sent carries its date (created_at). */
  live: MINUTE,
  /** A telegram older than this is never published (kept while the main container was away). */
  maxAge: 2 * 60 * MINUTE,
  /** Default and bounds of the silence delay (configurable, minutes). */
  silenceDefault: 5,
  silenceMin: 2,
  silenceMax: 60,
  /** Starting the receiver again after a failure. */
  receiverRetry: 30 * SECOND,
  /** getConfig() failed when Gladys connected: tried again, growing, without end. */
  configRetry: [5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE],
  /** /data unreadable at start: read again on a timer of its own. */
  dataRetry: 10 * SECOND,
  /** A /data read that does not finish is abandoned (the file is then "unreadable"). */
  dataTimeout: 10 * SECOND,
  /** What changed is written to /data at most this often. */
  saveDelay: 5 * SECOND,
  /** New devices or features: the Discovery is published again after this calm. */
  discoveryDelay: 2 * SECOND,
};
