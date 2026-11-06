// -----------------------------------------------------------------------------
// From a variable of a telegram to a Gladys feature, and the devices.
//
// Units: the ones the Home Assistant wiffi integration maps (`gradC`, `grad`,
// `%`, `mb`, `lux`, from its wiffi_strings.py) plus the ones the device
// writes literally and the core carries: `km/h`, `m/s` (speed), `mm/h`
// (precipitation per hour), `ppm` (CO2), `ppb` (VOC). A `mm` is a rain
// amount of the day or of the hour only when its name says so (a total of
// yesterday is not published). A `%` is a humidity or a soil moisture only
// when the name says so. A boolean is a rain or a motion sensor only when the
// name says so. Any other number or boolean is not published (the status
// lists it): never a guessed unit. `W/m2` (radiation) has no category in
// Gladys. A text (wind direction, ...) is a read-only text feature, except
// the network details of the device.
//
// Bounds: a value outside the range of its kind is no measurement (a sensor
// unplugged reports nonsense), it is not published.
//
// The feature key is the variable name (`homematic_name`, as Home Assistant
// keys its entities), frozen; the device is keyed by its MAC address.
// -----------------------------------------------------------------------------

import { ID_TYPE, LIMITS } from './constants.js';
import { formatMac } from './telegram.js';

const sensor = (category, type, unit, min, max) => ({ category, type, unit, min, max });

const BY_UNIT = {
  gradC: sensor('temperature-sensor', 'decimal', 'celsius', -60, 100),
  // A wind direction (0-360) or a sun elevation (-90-90).
  grad: sensor('angle-sensor', 'decimal', 'degree', -90, 360),
  mb: sensor('pressure-sensor', 'decimal', 'milli-bar', 300, 1200),
  lux: sensor('light-sensor', 'decimal', 'lux', 0, 200_000),
  'km/h': sensor('speed-sensor', 'decimal', 'kilometer-per-hour', 0, 400),
  'm/s': sensor('speed-sensor', 'decimal', 'meter-per-second', 0, 120),
  'mm/h': sensor('precipitation-sensor', 'decimal', 'millimeter-per-hour', 0, 500),
  ppm: sensor('co2-sensor', 'decimal', 'ppm', 0, 10_000),
  ppb: sensor('voc-sensor', 'decimal', 'ppb', 0, 100_000),
};

const MM = [
  [/gestern|yesterday|vortag/i, undefined],
  [/heute|tag|day|24/i, sensor('precipitation-sensor', 'decimal', 'millimeter-per-day', 0, 1000)],
  [
    /stunde|hour|1h|(^|_)(pro_)?h($|_)/i,
    sensor('precipitation-sensor', 'decimal', 'millimeter-per-hour', 0, 500),
  ],
];

const PERCENT = [
  [/boden|soil/i, sensor('soil-moisture-sensor', 'decimal', 'percent', 0, 100)],
  [/feucht|humid/i, sensor('humidity-sensor', 'decimal', 'percent', 0, 100)],
];

const BOOLEAN = [
  [/regen|rain/i, sensor('rain-sensor', 'binary', null, 0, 1)],
  [/beweg|motion|pir/i, sensor('motion-sensor', 'binary', null, 0, 1)],
];

/** Network details of the device: never published (they say nothing of the weather). */
const PRIVATE = /(^|_)(ip|ssid|mac)($|_)|wlan|adresse/i;

/**
 * @returns {{ spec: object } | { skip: 'unit' | 'private' }}
 *   spec: { kind, category, type, unit, min, max }, what the feature is.
 */
export function describe(metric) {
  if (metric.kind === 'string') {
    if (PRIVATE.test(metric.key)) return { skip: 'private' };
    return { spec: { kind: 'string', category: 'text', type: 'text', unit: null, min: 0, max: 0 } };
  }
  if (metric.kind === 'boolean') {
    const found = BOOLEAN.find(([name]) => name.test(metric.key));
    return found ? { spec: { kind: 'boolean', ...found[1] } } : { skip: 'unit' };
  }
  if (PRIVATE.test(metric.key)) return { skip: 'private' };
  let spec = Object.hasOwn(BY_UNIT, metric.unit) ? BY_UNIT[metric.unit] : undefined;
  if (metric.unit === '%' && !/abs/i.test(metric.key)) {
    spec = PERCENT.find(([name]) => name.test(metric.key))?.[1];
  }
  if (metric.unit === 'mm') {
    spec = MM.find(([name]) => name.test(metric.key))?.[1];
  }
  return spec ? { spec: { kind: 'number', ...spec, source: metric.unit } } : { skip: 'unit' };
}

/** Two specs describe the same feature (a changed unit is another feature). */
export const sameSpec = (a, b) =>
  Boolean(a && b) &&
  a.kind === b.kind &&
  a.category === b.category &&
  a.type === b.type &&
  a.unit === b.unit;

/**
 * The value to publish: `{ state }`, `{ text }`, or null (no value, out of range).
 */
export function stateOf(spec, value) {
  if (value === null || value === undefined) return null;
  if (spec.kind === 'string') {
    return typeof value === 'string' ? { text: value } : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < spec.min || value > spec.max) return null;
  return { state: value };
}

const cleanName = (text, fallback) => {
  const name = typeof text === 'string' ? text.trim().slice(0, 60) : '';
  return name || fallback;
};

/** The Gladys feature of a remembered spec. */
export function buildFeature(ids, key, spec) {
  const feature = {
    name: cleanName(spec.name, key),
    external_id: ids.feature(key),
    category: spec.category,
    type: spec.type,
    read_only: true,
    has_feedback: false,
    keep_history: spec.kind !== 'string',
    min: spec.min,
    max: spec.max,
  };
  if (spec.unit) feature.unit = spec.unit;
  return feature;
}

/** The ids of one Wiffi (by its MAC address). */
export const idsOf = (externalIds, mac) => externalIds(ID_TYPE, mac);

/**
 * The Gladys device of a remembered Wiffi; the features of the device already
 * created in Gladys that this memory no longer holds are kept as they are
 * (a republication never removes a feature).
 */
export function buildDevice(externalIds, mac, entry, created) {
  const ids = idsOf(externalIds, mac);
  const features = Object.entries(entry.features)
    .slice(0, LIMITS.featuresPerDevice)
    .map(([key, spec]) => buildFeature(ids, key, spec));
  const known = new Set(features.map((f) => f.external_id));
  for (const feature of created?.features ?? []) {
    if (typeof feature?.external_id === 'string' && !known.has(feature.external_id)) {
      known.add(feature.external_id);
      const kept = { read_only: true, has_feedback: false };
      for (const field of [
        'name',
        'external_id',
        'category',
        'type',
        'unit',
        'keep_history',
        'min',
        'max',
      ]) {
        if (feature[field] !== undefined && feature[field] !== null) kept[field] = feature[field];
      }
      features.push(kept);
    }
  }
  const label = `${entry.model} ${formatMac(mac).slice(9).replace(/:/g, '')}`;
  return {
    name: label,
    external_id: ids.device,
    model: entry.model,
    should_poll: false,
    features,
    params: [
      { name: 'WIFFI_MAC', value: formatMac(mac) },
      { name: 'WIFFI_MODEL', value: entry.model },
      ...(entry.firmware ? [{ name: 'WIFFI_FIRMWARE', value: entry.firmware }] : []),
      ...(entry.address ? [{ name: 'WIFFI_ADDRESS', value: entry.address }] : []),
    ],
  };
}
