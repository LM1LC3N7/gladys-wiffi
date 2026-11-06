// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. No version is
// written here: the versions must only agree (the Release workflow bumps them).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, TOKEN_KEY } from '../src/config.js';
import { RECEIVER, TIMINGS } from '../src/constants.js';
import { CHANNEL_PORT } from '../src/channel.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; the versions agree (semver, never a fixed one)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-wiffi:${manifest.version}`);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['environment']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+stall\.biz|sans\s+lien\s+avec\s+stall\.biz/i);
    assert.match(docs, /never\s+tested\s+with\s+a\s+real|jamais\s+testé\s+avec\s+un\s+vrai/i);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the receiver sub-container: same image, its command, one TCP port, no secret', () => {
  assert.equal(manifest.containers.length, 1);
  const [receiver] = manifest.containers;
  assert.equal(receiver.name, RECEIVER.name);
  assert.equal(receiver.docker_image, manifest.docker_image, 'released with the main image');
  assert.deepEqual(receiver.command, ['node', 'src/receiver.js']);
  assert.equal(receiver.start, 'manual', 'started by the app, with its secret in env');
  assert.equal(receiver.read_only, true);
  assert.equal(receiver.env, undefined, 'the manifest is public: no secret here');
  assert.equal(receiver.devices, undefined);
  assert.equal(receiver.volumes, undefined);
  assert.deepEqual(
    receiver.ports.map((port) => [port.container_port, port.protocol, port.name, port.browsable]),
    [[RECEIVER.tcpPort, 'tcp', RECEIVER.tcpPortName, false]],
  );
  assert.equal(RECEIVER.channelPort, CHANNEL_PORT, 'the channel port is never published');
  const names = receiver.ports.map((port) => port.name);
  let used = 0;
  for (const [, text] of texts(manifest.config_schema)) {
    for (const lang of ['en', 'fr']) {
      for (const [, name] of (text[lang] ?? '').matchAll(/\{\{port:([^}]+)\}\}/g)) {
        assert.ok(names.includes(name), `{{port:${name}}}`);
        used += 1;
      }
    }
  }
  assert.ok(used >= 2, 'the port is shown to the user');
});

test('the configuration matches the code; no gladys_ key; sections well formed', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema) {
    assert.notEqual(field.type, 'secret', 'no secret asked');
    if (field.default !== undefined)
      assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.equal(fields.silence_minutes.min, TIMINGS.silenceMin);
  assert.equal(fields.silence_minutes.max, TIMINGS.silenceMax);
  assert.ok(!(TOKEN_KEY in fields), `${TOKEN_KEY} stays out of the config_schema (never shown)`);
  for (const key of [...Object.keys(fields), TOKEN_KEY]) {
    assert.match(key, /^[a-z0-9_]+$/, key);
    assert.ok(!key.toUpperCase().startsWith('GLADYS_'), `${key}: reserved prefix`);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    for (const lang of ['en', 'fr'])
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('read only: no command handler, no action, nothing else declared', () => {
  assert.doesNotMatch(handlers, /gladys\.on(SetValue|Action|Poll)\(/);
  for (const key of [
    'actions',
    'scene_actions',
    'scene_triggers',
    'widgets',
    'webhooks',
    'network_discovery',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = read('Dockerfile');
  const copies = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY '))
    .join(' ');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'gladys-assistant-integration.json']) {
    assert.match(copies, new RegExp(`\\b${file.replace('.', '\\.')}\\b`), file);
    assert.ok(read(file).length > 100, file);
  }
  assert.doesNotMatch(read('LICENSE'), /Copyright \d{4} [A-Z][a-z]+ [A-Z]/, 'no person named');
  const ignored = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim());
  assert.ok(!ignored.some((l) => /^(LICENSE|THIRD_PARTY)/.test(l)));
  assert.ok(
    ignored.includes('test/') && ignored.includes('scripts/'),
    'tests and mutants out of the image',
  );
});
