// -----------------------------------------------------------------------------
// The mutants of the guards, replayable: `npm run mutants` (one at a time on a
// copy of the repository, the process group killed at the deadline). Each
// must make a test fail; an `equivalent` one (no behaviour change) is listed
// with why, and skipped. Not a test file: never run by `node --test`.
// -----------------------------------------------------------------------------

const M = (file, from, to, name, equivalent) => ({ file, from, to, name, equivalent });
const A = 'src/app.js';
const R = 'src/push/service.js';
const T = 'src/telegram.js';
const D = 'src/model.js';
const P = 'src/publisher.js';
const S = 'src/store.js';
const C = 'src/config.js';

export const MUTANTS = [
  // --- The receiver
  M(
    R,
    'if (allowed === null || !isAllowed(from, allowed)) {',
    'if (false) {',
    'receiver: any sender',
  ),
  M(
    R,
    "if (value === 'none') return null;",
    '',
    'receiver: none = private',
    'none is not an address: parseAllowed refuses it, null as well',
  ),
  M(R, 'if (size + piece.length > max) {', 'if (false) {', 'framer: no bound on an ended telegram'),
  M(R, 'if (size + rest.length > max) {', 'if (false) {', 'framer: no bound without an end'),
  M(
    R,
    'if (dead || size === 0) return;',
    'if (size === 0) return;',
    'framer: a cut telegram read at the end',
  ),
  M(
    R,
    'if (sameCount >= LIMITS.connectionsPerSource) {',
    'if (false) {',
    'receiver: no limit per source',
  ),
  M(
    R,
    '!evict((s) => s.bytesRead === 0) &&',
    '',
    'receiver: a connection mid-telegram evicted first',
  ),
  M(
    R,
    'if (socket.wiffiTelegrams >= LIMITS.telegramsPerConnection) {',
    'if (false) {',
    'receiver: no limit of telegrams per connection',
  ),
  M(
    R,
    'mine.length >= LIMITS.telegramsPerSource',
    'mine.length >= Infinity',
    'receiver: no rate per source',
  ),
  M(
    R,
    'const life = setTimeout(() => socket.destroy(), lifeMs);',
    'const life = 0;',
    'receiver: no life bound',
  ),
  M(
    R,
    '      idle = setTimeout(() => socket.destroy(), idleMs);',
    '',
    'receiver: idle not rearmed',
  ),
  M(R, 'seq += 1;', '', 'receiver: no sequence'),
  // --- The telegram
  M(
    T,
    'const NUMBER = /^-?\\d{1,9}(?:\\.\\d{1,9})?$/;',
    'const NUMBER = /^.*$/;',
    'telegram: loose numbers',
  ),
  M(
    T,
    "if (raw === true || raw === 'true') return 1;",
    'if (raw) return 1;',
    'telegram: loose booleans',
  ),
  M(T, 'parseInt(hex.slice(0, 2), 16) & 1', 'false', 'telegram: multicast MAC taken'),
  M(T, 'RESERVED.has(key) || !KINDS', '!KINDS', 'telegram: __proto__ as a key'),
  M(
    T,
    "if (text === '' || text.length > max || CONTROL.test(text)) return undefined;",
    "if (text === '') return undefined;",
    'telegram: control characters in texts',
  ),
  // --- The mapping
  M(D, 'if (value < spec.min || value > spec.max) return null;', '', 'model: no range'),
  M(
    D,
    "if (metric.unit === '%' && !/abs/i.test(metric.key)) {",
    "if (metric.unit === '%') {",
    'model: absolute humidity as %',
  ),
  M(
    D,
    "    if (PRIVATE.test(metric.key)) return { skip: 'private' };\n    return {",
    '    return {',
    'model: the IP as a text',
  ),
  M(
    D,
    "return found ? { spec: { kind: 'boolean', ...found[1] } } : { skip: 'unit' };",
    "return { spec: { kind: 'boolean', ...BOOLEAN[0][1] } };",
    'model: any boolean is rain',
  ),
  // --- The app
  M(A, 'if (age > TIMINGS.maxAge) {', 'if (false) {', 'app: telegrams over 2 h taken'),
  M(A, 'sent = Math.min(sent, now);', '', 'app: a future date taken as is'),
  M(
    A,
    'if (this.config.problem || !isAllowed(from, this.config.allowed)) {',
    'if (false) {',
    'app: no second source check',
  ),
  M(
    A,
    "ALLOWED: this.config.problem ? 'none' : this.config.allowed.join(','),",
    "ALLOWED: this.config.allowed.join(','),",
    'app: invalid list = private',
  ),
  M(A, 'order.seq <= previous.seq', 'false', 'app: older telegram applied'),
  M(
    A,
    'if (spec && !sameSpec(spec, described.spec)) {',
    'if (false) {',
    'app: changed unit published into the old feature',
  ),
  M(
    A,
    'if (created) this.publisher.push(featureId, state, sent);',
    'this.publisher.push(featureId, state, sent);',
    'app: states of devices not created',
  ),
  M(
    A,
    'return heard !== undefined && mono - heard < this.silenceMs();',
    'return heard !== undefined;',
    'app: never silent',
  ),
  M(A, 'if (mono - valid >= this.silenceMs()) mute.push(key);', '', 'app: mute sensors not named'),
  M(
    A,
    'if (last && valid !== undefined && mono - valid < this.silenceMs()) {',
    'if (last) {',
    'app: stale values republished at creation',
  ),
  M(
    A,
    'if (!this.loaded || this.unreadable) return false;',
    '',
    'app: /data written over when unreadable',
  ),
  M(
    A,
    "this.later('data', TIMINGS.dataRetry, () => this.loadMemory());",
    '',
    'app: /data never read again',
  ),
  M(
    A,
    'const delay = delays[Math.min(this.configAttempt, delays.length - 1)];',
    'const delay = Infinity;',
    'app: getConfig never tried again',
  ),
  M(
    A,
    '      this.gladys.forgetPublishedStates?.();\n',
    '',
    'app: dedup cache kept at reconnection',
  ),
  M(
    A,
    'const run = (this.applying ?? Promise.resolve()).then(() => {',
    'const run = Promise.resolve().then(() => {',
    'app: configurations applied concurrently',
  ),
  // --- The publisher
  M(
    P,
    'if (room <= 0 || this.pending.size === 0) {',
    'if (this.pending.size === 0) {',
    'publisher: no budget',
    'the loop breaks on room <= 0 as well: an empty batch either way',
  ),
  M(P, 'if (age > TIMINGS.live) {', 'if (false) {', 'publisher: late values not dated'),
  M(P, 'if (current && current.at > at) return;', '', 'publisher: older value replaces newer'),
  M(P, '      if (age > TIMINGS.maxAge) {', '      if (false) {', 'publisher: too old sent'),
  // --- /data and config
  M(S, "if (!info.isFile()) throw fail('ESPECIAL');", '', 'store: FIFO read'),
  M(
    S,
    "const handle = await open(temporary, 'wx', 0o600);",
    "const handle = await open(temporary, 'w', 0o600);",
    'store: FIFO as the temporary file',
    'the temporary file is removed just before: wx only closes a race',
  ),
  M(
    S,
    'if (!expected || !sameSpec(expected, spec)) return undefined;',
    'if (!expected) return undefined;',
    'store: a spec of another unit kept',
  ),
  M(C, 'bits < 16 ||', '', 'config: a /8 network allowed'),
  M(
    C,
    "if (!ip || unusable(ip) || ip === '255.255.255.255') {",
    'if (!ip) {',
    'config: broadcast allowed',
  ),
  M(C, '    return isPrivate(ip);\n', '    return true;\n', 'config: empty list = everyone'),
];
