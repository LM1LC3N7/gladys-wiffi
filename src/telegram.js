// -----------------------------------------------------------------------------
// A Wiffi JSON telegram, read as the reference library wiffi 1.1.2 (MIT,
// mampfes) reads it, bounded and strict:
//
//   { "modultyp": "weatherman",
//     "vars": [ { "name": "1", "homematic_name": "w_temperatur", "desc": "...",
//                 "type": "number" | "boolean" | "string", "unit": "gradC",
//                 "value": "12.3" }, ... ],
//     "Systeminfo": { "MAC-Adresse": "...", "firmware": "...", ... } }
//
// The device sends it over a TCP connection, terminated by 0x04 (the
// receiver cuts it). Some firmwares write a bare `nan` as a value (invalid
// JSON): read as "no value". A telegram preceded by HTTP headers (the "JSON
// with header" setting) is read after the headers.
//
// A value is a measurement only when it is a plain decimal number (an empty
// text, "nan", "-", a comma decimal are no value, never 0), a boolean only
// when it is exactly true or false.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const KEY = /^[A-Za-z0-9_-]+$/;
const NUMBER = /^-?\d{1,9}(?:\.\d{1,9})?$/;
const KINDS = new Set(['number', 'boolean', 'string']);
/** Names that would reach the prototype of a plain object: never a feature key. */
export const RESERVED = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
]);

/** A short text without control characters, or undefined. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > max || CONTROL.test(text)) return undefined;
  return text;
}

/** "AC:67:B2:11:22:33" (or with dashes, or none) -> "ac67b2112233"; undefined if not a unicast MAC. */
export function normalizeMac(value) {
  if (typeof value !== 'string' || value.length > 24) return undefined;
  const text = value.trim().toLowerCase();
  if (!/^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/.test(text)) return undefined;
  const hex = text.replace(/[:-]/g, '');
  if (/^0+$/.test(hex) || /^f+$/.test(hex) || parseInt(hex.slice(0, 2), 16) & 1) {
    return undefined;
  }
  return hex;
}

export const formatMac = (hex) => hex.match(/../g).join(':').toUpperCase();

/** The number of a value, or null (no value). */
export function numberOf(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return NUMBER.test(text) ? Number(text) : null;
}

/** 1, 0 or null (no value). */
export function booleanOf(raw) {
  if (raw === true || raw === 'true') return 1;
  if (raw === false || raw === 'false') return 0;
  return null;
}

/** The JSON text of a telegram, without HTTP headers before it. */
function bodyOf(text) {
  if (/^[A-Z]{3,7} \S{1,256} HTTP\/1\.[01]\r?\n/.test(text)) {
    const end = text.search(/\r?\n\r?\n/);
    return end < 0 ? '' : text.slice(end).trim();
  }
  return text.trim();
}

/**
 * @param {string} text - One telegram (without its 0x04).
 * @returns {{ error: string } | { mac: string, model: string, firmware: string, metrics: Array, dropped: number }}
 *   metrics: [{ key, desc, kind, unit, value }] where value is a number (number), 1/0
 *   (boolean), a string (string) or null (no value).
 */
export function parseTelegram(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { error: 'empty' };
  }
  if (Buffer.byteLength(text, 'utf8') > LIMITS.telegramBytes) {
    return { error: 'size' };
  }
  const body = bodyOf(text);
  if (!body.startsWith('{')) {
    return { error: 'json' };
  }
  let data;
  try {
    data = JSON.parse(body.replace(/("value"\s*:\s*)-?(?:nan|inf)\s*(?=[,}])/gi, '$1null'));
  } catch {
    return { error: 'json' };
  }
  if (!isObject(data)) {
    return { error: 'json' };
  }
  const system = own(data, 'Systeminfo');
  const vars = own(data, 'vars');
  if (!isObject(system) || !Array.isArray(vars)) {
    return { error: 'shape' };
  }
  const mac = normalizeMac(own(system, 'MAC-Adresse'));
  if (!mac) {
    return { error: 'mac' };
  }
  const model = cleanText(own(data, 'modultyp'), 32);
  const firmware = cleanText(own(system, 'firmware'), 32) ?? '';
  const metrics = [];
  const seen = new Set();
  let dropped = Math.max(0, vars.length - LIMITS.vars);
  for (const entry of vars.slice(0, LIMITS.vars)) {
    const key = cleanText(own(entry, 'homematic_name'), LIMITS.keyLength);
    const kind = own(entry, 'type');
    if (!key || !KEY.test(key) || RESERVED.has(key) || !KINDS.has(kind) || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    const unitRaw = own(entry, 'unit');
    const unit =
      unitRaw === undefined || unitRaw === null ? '' : cleanText(unitRaw, LIMITS.unitLength);
    if (unit === undefined && unitRaw !== '') {
      dropped += 1;
      continue;
    }
    const raw = own(entry, 'value');
    let value;
    if (kind === 'number') value = numberOf(raw);
    else if (kind === 'boolean') value = booleanOf(raw);
    else value = cleanText(raw, LIMITS.textLength) ?? null;
    metrics.push({
      key,
      desc: cleanText(own(entry, 'desc'), LIMITS.descLength) ?? '',
      kind,
      unit: unit ?? '',
      value,
    });
  }
  return { mac, model: model ?? 'wiffi', firmware, metrics, dropped };
}
