// -----------------------------------------------------------------------------
// The pure parts: the telegram, the mapping, the configuration, the memory.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAllowed,
  isPrivate,
  normalizeConfig,
  normalizeSilence,
  parseAllowed,
} from '../src/config.js';
import { LIMITS } from '../src/constants.js';
import { buildDevice, describe, stateOf } from '../src/model.js';
import { fileStore, normalizeMemory } from '../src/store.js';
import { booleanOf, normalizeMac, numberOf, parseTelegram } from '../src/telegram.js';
import { WEATHERMAN } from './helpers/app.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

test('telegram: the fixture read as wiffi 1.1.2 reads it, nan as no value', () => {
  const t = parseTelegram(WEATHERMAN);
  assert.equal(t.mac, '5ccf7f112233');
  assert.equal(t.model, 'weatherman');
  assert.equal(t.firmware, 'wm_133');
  assert.equal(t.metrics.length, 12);
  assert.equal(t.metrics.find((m) => m.key === 'w_taupunkt').value, null);
  assert.equal(t.metrics.find((m) => m.key === 'w_temperatur').value, 12.4);
  assert.equal(t.metrics.find((m) => m.key === 'w_regen').value, 0);
  assert.equal(t.metrics.find((m) => m.key === 'w_windrichtung').value, 'NO');
});

test('telegram: strict numbers and booleans; never a 0 from a text', () => {
  for (const raw of [
    '',
    ' ',
    'nan',
    '-',
    '1,5',
    '12a',
    'Aus',
    '1e3',
    '0x10',
    null,
    undefined,
    true,
    NaN,
    Infinity,
  ]) {
    assert.equal(numberOf(raw), null, String(raw));
  }
  assert.equal(numberOf('-3.25'), -3.25);
  assert.equal(numberOf(' 7 '), 7);
  assert.equal(numberOf(0), 0);
  assert.equal(booleanOf('true'), 1);
  assert.equal(booleanOf(false), 0);
  for (const raw of ['TRUE', '1', 1, 'yes', '', null])
    assert.equal(booleanOf(raw), null, String(raw));
});

test('telegram: MAC unicast only; refused shapes; bounded; duplicates and bad names dropped', () => {
  assert.equal(normalizeMac('5c-cf-7f-11-22-33'), '5ccf7f112233');
  assert.equal(normalizeMac('5ccf7f112233'), '5ccf7f112233');
  for (const bad of [
    '00:00:00:00:00:00',
    'FF:FF:FF:FF:FF:FF',
    '01:00:5E:00:00:01',
    '5C:CF:7F:11:22',
    'x',
    12,
  ]) {
    assert.equal(normalizeMac(bad), undefined, String(bad));
  }
  assert.deepEqual(parseTelegram(''), { error: 'empty' });
  assert.deepEqual(parseTelegram('hello'), { error: 'json' });
  assert.deepEqual(parseTelegram('[1]'), { error: 'json' });
  assert.deepEqual(parseTelegram('{"vars":{}}'), { error: 'shape' });
  assert.deepEqual(parseTelegram(`{"x":"${'a'.repeat(LIMITS.telegramBytes)}"}`), { error: 'size' });
  const vars = [
    { homematic_name: 'a', type: 'number', unit: 'gradC', value: '1' },
    { homematic_name: 'a', type: 'number', unit: 'gradC', value: '2' },
    { homematic_name: 'b.c', type: 'number', unit: 'gradC', value: '1' },
    { homematic_name: 'd', type: 'object', value: '1' },
    { homematic_name: 'e', type: 'string', unit: 'x\ny', value: '1' },
    { homematic_name: 'f', type: 'string', value: 'a\u0007b' },
    { homematic_name: '__proto__', type: 'string', value: 'x' },
    ...Array.from({ length: LIMITS.vars }, (_, i) => ({
      homematic_name: `v${i}`,
      type: 'string',
      value: 'x',
    })),
  ];
  const t = parseTelegram(
    JSON.stringify({ modultyp: 'x', vars, Systeminfo: { 'MAC-Adresse': '5C:CF:7F:11:22:33' } }),
  );
  assert.equal(t.metrics.length, LIMITS.vars - 5);
  assert.equal(t.metrics[0].value, 1);
  assert.equal(t.metrics.find((m) => m.key === 'f').value, null, 'a control character is no text');
  assert.equal(t.dropped, 5 + 7);
});

test('mapping: only the known units; names decide % and booleans; network details never', () => {
  const d = (key, kind, unit = '') => describe({ key, kind, unit });
  assert.equal(d('w_temp', 'number', 'gradC').spec.category, 'temperature-sensor');
  assert.equal(d('w_boden_feuchte', 'number', '%').spec.category, 'soil-moisture-sensor');
  assert.equal(d('w_feuchte_rel', 'number', '%').spec.category, 'humidity-sensor');
  assert.equal(d('w_feuchte_abs', 'number', '%').skip, 'unit');
  assert.equal(d('w_akku', 'number', '%').skip, 'unit');
  assert.equal(d('w_regen_mm', 'number', 'mm').skip, 'unit', 'neither a day nor an hour');
  assert.equal(d('r_menge_heute', 'number', 'mm').spec.unit, 'millimeter-per-day');
  assert.equal(d('r_regen_24h', 'number', 'mm').spec.unit, 'millimeter-per-day');
  assert.equal(d('r_pro_h', 'number', 'mm').spec.unit, 'millimeter-per-hour');
  assert.equal(d('r_menge_stunde', 'number', 'mm').spec.unit, 'millimeter-per-hour');
  assert.equal(d('r_menge_gestern', 'number', 'mm').skip, 'unit', 'yesterday is not today');
  assert.equal(
    d('r_tag_gestern', 'number', 'mm').skip,
    'unit',
    'yesterday, even named for the day',
  );
  assert.equal(d('r_intens', 'number', 'mm/h').spec.category, 'precipitation-sensor');
  assert.equal(d('r_intens', 'number', 'mm/h').spec.source, 'mm/h');
  assert.equal(d('a_co2', 'number', 'ppm').spec.category, 'co2-sensor');
  assert.equal(d('a_voc', 'number', 'ppb').spec.category, 'voc-sensor');
  assert.equal(d('a_kohlendioxid', 'number', 'ppm').spec.category, 'co2-sensor');
  assert.equal(d('a_co', 'number', 'ppm').spec.category, 'co-sensor', 'CO is never shown as CO2');
  assert.equal(d('a_co', 'number', 'ppm').spec.unit, 'ppm');
  assert.equal(d('a_kohlenmonoxid', 'number', 'ppm').spec.category, 'co-sensor');
  assert.equal(d('a_formaldehyd', 'number', 'ppm').skip, 'unit', 'another gas: not published');
  assert.equal(d('a_luftqualitaet', 'number', 'ppm').skip, 'unit');
  assert.equal(d('a_nox', 'number', 'ppb').skip, 'unit', 'ppb is VOC only by its name');
  assert.equal(
    d('regen_tag', 'number', 'mm').spec.unit,
    'millimeter-per-day',
    'tag alone is the day',
  );
  assert.equal(
    d('regen_tag_h', 'number', 'mm').skip,
    'unit',
    'day and hour: ambiguous, not published',
  );
  assert.equal(d('w_strahlung', 'number', 'W/m2').skip, 'unit', 'no category for radiation');
  assert.equal(d('w_ip_num', 'number', 'gradC').skip, 'private', 'network details, numbers too');
  assert.equal(d('w_x', 'number', '').skip, 'unit');
  assert.equal(d('w_bewegung', 'boolean').spec.category, 'motion-sensor');
  assert.equal(d('w_relais', 'boolean').skip, 'unit');
  assert.equal(d('w_ip', 'string').skip, 'private');
  assert.equal(d('wlan_ssid', 'string').skip, 'private');
  assert.equal(d('w_wind_text', 'string').spec.category, 'text');
  assert.equal(d('__proto__', 'number', 'constructor').skip, 'unit');
  const temp = d('t', 'number', 'gradC').spec;
  assert.deepEqual(stateOf(temp, 21.5), { state: 21.5 });
  assert.equal(stateOf(temp, -99), null, 'a probe unplugged');
  assert.equal(stateOf(temp, 150), null);
  const wind = d('w_dir', 'number', 'grad').spec;
  assert.deepEqual(stateOf(wind, 360), { state: 360 });
  assert.equal(stateOf(wind, -91), null);
  assert.equal(stateOf(temp, null), null);
  assert.deepEqual(stateOf(d('s', 'string').spec, 'NO'), { text: 'NO' });
  assert.equal(stateOf(d('s', 'string').spec, 3), null);
});

test('mapping: name rules word by word; a stem anywhere; CO is the word co only', () => {
  const as = (key, unit, kind = 'number') => {
    const d = describe({ key, kind, unit });
    if (!d.spec) return `skip:${d.skip}`;
    return d.spec.unit ? `${d.spec.category}/${d.spec.unit}` : d.spec.category;
  };
  const NO = 'skip:unit';
  const CO = 'co-sensor/ppm';
  const CO2 = 'co2-sensor/ppm';
  const VOC = 'voc-sensor/ppb';
  const DAY = 'precipitation-sensor/millimeter-per-day';
  const HOUR = 'precipitation-sensor/millimeter-per-hour';
  const HUMIDITY = 'humidity-sensor/percent';
  const SOIL = 'soil-moisture-sensor/percent';
  const cases = [
    // ppm: CO only for the word co (a second probe `co_1` too), never "co" inside a word.
    ['co', 'ppm', CO],
    ['a_co', 'ppm', CO],
    ['co_wert', 'ppm', CO],
    ['a_co_1', 'ppm', CO],
    ['A_CO', 'ppm', CO],
    ['compressor', 'ppm', NO],
    ['a_coil', 'ppm', NO],
    ['cooling', 'ppm', NO],
    ['a_cof', 'ppm', NO],
    ['a_kohlenmonoxid', 'ppm', CO],
    ['a_kohlenmonoxidgehalt', 'ppm', CO],
    ['carbon_monoxide', 'ppm', CO],
    ['a_carbonmonoxide', 'ppm', CO],
    // ppm: CO2 by its stem, anywhere (`eco2`, the CO2 equivalent of air sensors); never CO.
    ['a_co2', 'ppm', CO2],
    ['A_CO2', 'ppm', CO2],
    ['co2_wert', 'ppm', CO2],
    ['a_eco2', 'ppm', CO2],
    ['a_kohlendioxid', 'ppm', CO2],
    ['a_kohlendioxidgehalt', 'ppm', CO2],
    ['carbon_dioxide', 'ppm', CO2],
    ['carbondioxide', 'ppm', CO2],
    // `co_2`: CO2 written with a `_`, or the second CO probe? Neither is published.
    ['a_co_2', 'ppm', NO],
    ['co_2_wert', 'ppm', NO],
    ['a_formaldehyd', 'ppm', NO],
    // ppb: VOC by its stem (`tvoc`); another gas never.
    ['a_voc', 'ppb', VOC],
    ['a_tvoc', 'ppb', VOC],
    ['a_no2', 'ppb', NO],
    // mm: the day or the hour by a word of the name; `tag` inside a word is not the day.
    ['regen_heute', 'mm', DAY],
    ['regen_tag', 'mm', DAY],
    ['rain_today', 'mm', DAY],
    ['rain_day', 'mm', DAY],
    ['regen_24', 'mm', DAY],
    ['regen_24h', 'mm', DAY],
    ['regen_h24', 'mm', DAY],
    ['stage', 'mm', NO],
    ['montag_regen', 'mm', NO],
    ['tagesregen', 'mm', NO],
    ['regen_stunde', 'mm', HOUR],
    ['rain_per_hour', 'mm', HOUR],
    ['regen_1h', 'mm', HOUR],
    ['regen_pro_h', 'mm', HOUR],
    ['regen1h', 'mm', NO],
    ['r_11h', 'mm', NO],
    ['r_hagel', 'mm', NO],
    ['regen_tag_h', 'mm', NO],
    // yesterday, anywhere in the name (the safe side): never today.
    ['r_tag_gestern', 'mm', NO],
    ['r_tag_vorgestern', 'mm', NO],
    ['r_vortag_24h', 'mm', NO],
    ['rain_yesterday_24h', 'mm', NO],
    // %: humidity and soil moisture by their stems (German writes them in one word).
    ['w_feuchte_rel', '%', HUMIDITY],
    ['w_luftfeuchte', '%', HUMIDITY],
    ['w_humidity', '%', HUMIDITY],
    ['w_boden_feuchte', '%', SOIL],
    ['w_bodenfeuchte', '%', SOIL],
    ['w_soil_moisture', '%', SOIL],
    ['w_feuchte_abs', '%', NO],
    ['w_feuchte_absolut', '%', NO],
    // booleans: `regen` anywhere (`starkregen`), `rain` starting a word, `pir` as a word.
    ['w_regen', '', 'rain-sensor', 'boolean'],
    ['w_starkregen', '', 'rain-sensor', 'boolean'],
    ['w_rain', '', 'rain-sensor', 'boolean'],
    ['w_raining', '', 'rain-sensor', 'boolean'],
    ['w_drain', '', NO, 'boolean'],
    ['w_train', '', NO, 'boolean'],
    ['w_bewegung', '', 'motion-sensor', 'boolean'],
    ['w_motion', '', 'motion-sensor', 'boolean'],
    ['w_pir', '', 'motion-sensor', 'boolean'],
    ['w_expired', '', NO, 'boolean'],
    ['w_spirit', '', NO, 'boolean'],
    // network details: anywhere in the name (the safe side).
    ['w_mac', '', 'skip:private', 'string'],
    ['w_ssid', '', 'skip:private', 'string'],
    ['w_wlan_name', '', 'skip:private', 'string'],
    ['w_ipadresse', '', 'skip:private', 'string'],
    ['w_wind_text', '', 'text', 'string'],
  ];
  for (const [key, unit, expected, kind] of cases) {
    assert.equal(as(key, unit, kind), expected, `${key} (${unit || kind})`);
  }
  assert.notEqual(as('a_co_2', 'ppm'), CO, 'co_2 is never CO');
});

test('mapping: a gas outside its range is no measurement, the bounds themselves are', () => {
  const spec = (key, unit) => describe({ key, kind: 'number', unit }).spec;
  for (const [key, unit, max] of [
    ['a_co', 'ppm', 1000],
    ['a_co2', 'ppm', 10_000],
    ['a_voc', 'ppb', 100_000],
  ]) {
    const s = spec(key, unit);
    assert.deepEqual(stateOf(s, 0), { state: 0 }, `${key} 0`);
    assert.deepEqual(stateOf(s, max), { state: max }, `${key} ${max}`);
    assert.equal(stateOf(s, max + 0.1), null, `${key} ${max + 0.1}`);
    assert.equal(stateOf(s, -0.1), null, `${key} -0.1`);
  }
});

test('devices: every feature passes the rules of the core; a created feature never lost', () => {
  const t = parseTelegram(WEATHERMAN);
  const features = {};
  for (const m of t.metrics) {
    const spec = describe(m).spec;
    if (spec) features[m.key] = { ...spec, name: m.desc };
  }
  const ids = (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (k) => `ext:x:${type}:${id}:${k}`,
  });
  const entry = { model: 'weatherman', firmware: 'wm_133', address: '192.168.1.50', features };
  const created = {
    features: [
      {
        external_id: 'ext:x:wiffi:5ccf7f112233:w_old',
        name: 'Old',
        category: 'light-sensor',
        type: 'decimal',
        unit: 'lux',
        min: 0,
        max: 1,
        last_value: 3,
      },
    ],
  };
  const device = buildDevice(ids, t.mac, entry, created);
  assertCoreDevice(device, 'weatherman');
  const old = device.features.find((f) => f.external_id.endsWith(':w_old'));
  assert.ok(old);
  assert.equal(old.last_value, undefined);
});

test('config: allowed senders strict; invalid entry by position; silence bounded', () => {
  assert.deepEqual(parseAllowed(''), { list: [] });
  assert.deepEqual(parseAllowed(' 192.168.1.5 ,10.0.0.0/24;fd00::5 '), {
    list: ['192.168.1.5', '10.0.0.0/24', 'fd00::5'],
  });
  assert.deepEqual(parseAllowed('192.168.1.5, wiffi'), { error: 'invalid', index: 2 });
  for (const bad of ['0.0.0.0', '255.255.255.255', '224.0.0.1', '10.0.0.0/8', 'ff02::1', '::']) {
    assert.equal(parseAllowed(bad).error, 'invalid', bad);
  }
  assert.equal(
    parseAllowed(
      Array(LIMITS.allowedAddresses + 1)
        .fill('10.0.0.1')
        .join(','),
    ).error,
    'too-many',
  );
  assert.ok(isAllowed('::ffff:192.168.1.5', ['192.168.1.5']));
  assert.ok(isAllowed('10.0.0.200', ['10.0.0.0/24']));
  assert.ok(!isAllowed('10.0.1.1', ['10.0.0.0/24']));
  assert.ok(isAllowed('192.168.3.4', []));
  assert.ok(!isAllowed('8.8.8.8', []));
  assert.ok(!isAllowed('', []));
  for (const ip of [
    '10.1.2.3',
    '172.31.0.1',
    '192.168.0.1',
    '169.254.1.1',
    'fd12::1',
    'fe80::1',
    '::1',
  ]) {
    assert.ok(isPrivate(ip), ip);
  }
  for (const ip of ['172.32.0.1', '8.8.8.8', '2001:db8::1', '0.0.0.1'])
    assert.ok(!isPrivate(ip), ip);
  assert.equal(normalizeSilence('10'), 10);
  assert.equal(normalizeSilence(1), 2);
  assert.equal(normalizeSilence(1000), 60);
  assert.equal(normalizeSilence(''), 5);
  assert.equal(normalizeSilence('x'), 5);
  assert.deepEqual(normalizeConfig({ allowed_addresses: 'x' }).problem, {
    kind: 'invalid',
    index: 1,
  });
});

test('memory: only known shapes back; a spec that no longer matches its unit is dropped', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const raw = JSON.parse(`{"devices":{
    "5ccf7f112233":{"model":"weatherman","firmware":"wm","address":"192.168.1.50","lastAt":${now - 1000},
      "features":{"w_temperatur":{"kind":"number","category":"temperature-sensor","type":"decimal","unit":"celsius","name":"T","source":"gradC"},
                  "r_heute":{"kind":"number","category":"precipitation-sensor","type":"decimal","unit":"millimeter-per-day","source":"mm"},
                  "w_nosource":{"kind":"number","category":"temperature-sensor","type":"decimal","unit":"celsius"},
                  "w_bad":{"kind":"number","category":"temperature-sensor","type":"decimal","unit":"kelvin","source":"gradC"},
                  "w_mixed":{"kind":"number","category":"humidity-sensor","type":"decimal","unit":"celsius","source":"gradC"},
                  "__proto__":{"kind":"string","category":"text","type":"text"}}},
    "nope":{"model":"x"},
    "5ccf7f000001":{"model":"a\\u0001b","lastAt":${now + 60000},"features":{"t":{"kind":"string","category":"text","type":"text"}}},
    "5ccf7f000002":{"model":"empty","features":{}}}}`);
  const memory = normalizeMemory(raw, now);
  assert.deepEqual(Object.keys(memory.devices).sort(), ['5ccf7f000001', '5ccf7f112233']);
  const entry = memory.devices['5ccf7f112233'];
  assert.deepEqual(Object.keys(entry.features), ['w_temperatur', 'r_heute']);
  assert.equal(entry.features.r_heute.unit, 'millimeter-per-day');
  assert.equal(Object.getPrototypeOf(entry.features), Object.prototype, 'never a prototype set');
  assert.equal(entry.features.w_temperatur.min, -60);
  assert.equal(memory.devices['5ccf7f000001'].model, 'wiffi');
  assert.equal(memory.devices['5ccf7f000001'].lastAt, 0, 'a future date is no date');
  assert.deepEqual(normalizeMemory(null, now), { devices: {} });
});

test('file store: round trip 0600, missing = null, FIFO and oversize refused without blocking', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wiffi-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = fileStore(join(dir, 'wiffi.json'), { timeout: 2000 });
  assert.equal(await store.load(), null);
  await store.save({ devices: {} });
  assert.deepEqual(await store.load(), { devices: {} });
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  const started = Date.now();
  await assert.rejects(fileStore(fifo, { timeout: 2000 }).load(), { code: 'ESPECIAL' });
  assert.ok(Date.now() - started < 1500);
  // A FIFO left as the temporary file never blocks a save.
  execFileSync('mkfifo', [join(dir, 'w2.json.tmp')]);
  await fileStore(join(dir, 'w2.json')).save({ devices: {} });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'w2.json'), 'utf8')), { devices: {} });
  await writeFile(join(dir, 'big.json'), 'x'.repeat(LIMITS.memoryBytes + 1));
  await assert.rejects(fileStore(join(dir, 'big.json')).load(), { code: 'ETOOBIG' });
});
