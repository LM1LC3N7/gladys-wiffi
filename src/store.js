// -----------------------------------------------------------------------------
// What must survive a restart, in /data/wiffi.json (0600): the Wiffis heard
// and their features, so the Discovery and the devices keep every feature
// after a restart, before the next telegram.
//
//   devices  { <mac>: { model, firmware, address, lastAt, features } }
//            lastAt: when its last telegram arrived (wall clock: only read
//            again at start, to tell a Wiffi silent since before the restart)
//            features: { <key>: { kind, category, type, unit, min, max, name } }
//
// Never a secret, never a value. Read back bounded, only known keys of the
// expected shape (never an inherited or `__proto__` key). A file that is not
// a regular file (a FIFO, a device) is refused without blocking; a read
// that does not finish is abandoned.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { describe, sameSpec } from './model.js';
import { RESERVED, cleanText } from './telegram.js';

export const STATE_FILE = '/data/wiffi.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

const fail = (code) => Object.assign(new Error(code), { code });

async function readBounded(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw fail('ESPECIAL');
    if (info.size > LIMITS.memoryBytes) throw fail('ETOOBIG');
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close().catch(() => {});
  }
}

export function fileStore(path = STATE_FILE, { timeout = TIMINGS.dataTimeout } = {}) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** null when there is no file yet; throws when it exists but cannot be read in time. */
    load() {
      let timer;
      return Promise.race([
        readBounded(path),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail('ETIMEDOUT')), timeout);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (Buffer.byteLength(text) > LIMITS.memoryBytes) throw fail('ETOOBIG');
        const temporary = `${path}.tmp`;
        await unlink(temporary).catch(() => {});
        // 'wx': never opens what is already there (a FIFO would block).
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close().catch(() => {});
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    loads: 0,
    failing,
    unreadable,
    async load() {
      this.loads += 1;
      if (this.unreadable) {
        throw fail('EACCES');
      }
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw fail('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

export const emptyMemory = () => ({ devices: {} });

const wallTime = (value, now) => (Number.isFinite(value) && value > 0 && value <= now ? value : 0);

/** A remembered feature, checked against what describe() would build for it. */
function normalizeSpec(key, raw) {
  const kind = own(raw, 'kind');
  const unitRaw = own(raw, 'unit');
  const metric = { key, kind, unit: '' };
  // Find the unit of the telegram back from the Gladys unit.
  if (kind === 'number') {
    const units = {
      celsius: 'gradC',
      degree: 'grad',
      'milli-bar': 'mb',
      lux: 'lux',
      'kilometer-per-hour': 'km/h',
      'meter-per-second': 'm/s',
      percent: '%',
    };
    metric.unit =
      typeof unitRaw === 'string' && Object.hasOwn(units, unitRaw) ? units[unitRaw] : '';
  }
  const expected = describe(metric).spec;
  const spec = {
    kind,
    category: own(raw, 'category'),
    type: own(raw, 'type'),
    unit: unitRaw ?? null,
  };
  if (!expected || !sameSpec(expected, spec)) return undefined;
  const name = own(raw, 'name');
  return {
    ...expected,
    name: typeof name === 'string' && name.length <= LIMITS.descLength ? name : key,
  };
}

/** The persisted state, repaired and bounded against `now`. */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  const devices = own(raw, 'devices');
  if (!isObject(devices)) return memory;
  for (const mac of Object.keys(devices).slice(0, LIMITS.devices)) {
    if (!/^[0-9a-f]{12}$/.test(mac)) continue;
    const entry = devices[mac];
    const model = own(entry, 'model');
    const firmware = own(entry, 'firmware');
    const address = own(entry, 'address');
    const features = {};
    const rawFeatures = own(entry, 'features');
    if (isObject(rawFeatures)) {
      for (const key of Object.keys(rawFeatures).slice(0, LIMITS.featuresPerDevice)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || RESERVED.has(key)) continue;
        const spec = normalizeSpec(key, rawFeatures[key]);
        if (spec) features[key] = spec;
      }
    }
    memory.devices[mac] = {
      model: cleanText(model, 32) ?? 'wiffi',
      firmware: cleanText(firmware, 32) ?? '',
      address:
        typeof address === 'string' && address.length <= 64 && /^[0-9a-f.:]+$/i.test(address)
          ? address
          : '',
      lastAt: wallTime(own(entry, 'lastAt'), now),
      features,
    };
  }
  return memory;
}

export const serializeMemory = (memory) => ({ devices: memory.devices });
