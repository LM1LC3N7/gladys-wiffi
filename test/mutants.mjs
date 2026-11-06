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
const Ch = 'src/channel.js';

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
  // --- Review r1 (the reviewer's mutants, adapted to the corrected code, and the corrections')
  M(R, "if (window.length >= LIMITS.telegramsPerMinute) return 'total';", '', 'r1: no total rate'),
  M(
    R,
    '!evict((s) => s.wiffiTelegrams === 0)',
    '!evict(() => false)',
    'r1: mid-telegram never evicted, newcomer refused',
  ),
  M(
    R,
    'if (mono - (lastNotice.get(reason) ?? -Infinity) < TIMINGS.refusedNotice) return;',
    '',
    'r1: refusal notices unthrottled',
  ),
  M(R, '      framer.end();\n', '', 'r1: telegram without 0x04 lost'),
  M(R, 'queueSize: LIMITS.queue,', 'queueSize: 1e9,', 'r1: unbounded queue'),
  M(
    R,
    "if (!ended && text.trim() === '') return true;",
    "if (text.trim() === '') return true;",
    'r1: blank frames not counted',
  ),
  M(R, "} else if (text.trim() !== '') {", '} else {', 'r1: blank frames forwarded'),
  M(
    R,
    'if (received > LIMITS.connectionBytes) {',
    'if (false) {',
    'r1: bytes per connection unbounded',
  ),
  M(
    R,
    'if (!bySource.has(from) && bySource.size >= LIMITS.sources) bySource.clear();',
    '',
    'r1: sources table unbounded',
    'only memory: 256 sources at 60/min need more than the 240/min total allows to matter; no observable behaviour',
  ),
  M(
    R,
    'tcp.maxConnections = LIMITS.connections * 4;',
    '',
    'r1: no hard connection cap',
    'a backstop under the 16 managed connections, which are evicted or refused first',
  ),
  M(
    Ch,
    "sameProof(object.proof, proof(secret, 'client', serverNonce, object.nonce))",
    'true',
    'r1: server accepts any client',
  ),
  M(
    Ch,
    "!sameProof(object.proof, proof(this.secret, 'server', clientNonce, serverNonce))",
    'false',
    'r1: client accepts any server',
  ),
  M(
    Ch,
    'if (line.length > MAX_LINE) {',
    'if (false) {',
    'r1: no line bound',
    'the bound on the unfinished line (size > MAX_LINE) cuts any long line first: loopback chunks are far smaller than 512 KB',
  ),
  M(A, '    entry.lastAt = sent;\n', '', 'r1: lastAt never kept'),
  M(
    A,
    'this.heard.set(mac, Math.max(this.heard.get(mac) ?? -Infinity, heardAt));',
    'this.heard.set(mac, heardAt);',
    'r1: heard may go back',
  ),
  M(
    A,
    'this.store.save(serializeMemory(this.memory)).catch(() => {}),',
    'Promise.resolve(),',
    'r1: no /data write at clean stop',
  ),
  M(
    A,
    'if (this.channel && this.channel.secret === this.token) return;',
    'if (this.channel) return;',
    'r1: channel kept with a new secret',
  ),
  M(
    A,
    'this.lastReceiverEnv !== JSON.stringify(this.receiverEnv())',
    'false',
    'r1: receiver not restarted on env change by tick',
    'every failed startContainer sets the status to error, which the round retries anyway',
  ),
  M(
    A,
    'if (this.unsupported.size >= 50) return;',
    '',
    'r1: unsupported list unbounded',
    'the status shows 20 names either way: the bound only caps memory',
  ),
  M(
    A,
    '?? this.startMono;\n      if (mono - valid >= this.silenceMs()) mute.push(key);',
    '?? Infinity;\n      if (mono - valid >= this.silenceMs()) mute.push(key);',
    'r1: never-valid sensor not named',
  ),
  M(
    A,
    'if (mono - entry.last < REFUSED_SHOWN) refused[reason] = entry;',
    'refused[reason] = entry;',
    'r1: refusals shown forever',
  ),
  M(P, 'if (!this.pending.has(id)) this.pending.set(id, entry);', '', 'r1: failed batch lost'),
  M(
    C,
    'Math.max(TIMINGS.silenceMin, Math.round(value))',
    'Math.round(value)',
    'r1: silence below 2 min',
  ),
  M(C, 'if (parts.length > LIMITS.allowedAddresses) {', 'if (false) {', 'r1: unbounded list'),
  M(
    T,
    "if (Buffer.byteLength(text, 'utf8') > LIMITS.telegramBytes) {",
    'if (false) {',
    'r1: no size check in the parser',
  ),
  M(T, '|| seen.has(key)', '', 'r1: duplicate names kept'),
  M(
    D,
    "if (typeof feature?.external_id === 'string' && !known.has(feature.external_id)) {",
    'if (false) {',
    'r1: created features lost at republication',
  ),
  M(
    D,
    "  'mm/h': sensor('precipitation-sensor', 'decimal', 'millimeter-per-hour', 0, 500),\n",
    '',
    'r1: no mm/h',
  ),
  M(D, '  [/gestern|yesterday|vortag/i, undefined],\n', '', 'r1: yesterday published as today'),
  M(D, "  ppm: sensor('co2-sensor', 'decimal', 'ppm', 0, 10_000),\n", '', 'r1: no ppm'),
  M(
    A,
    '      if (!parsed.metrics.some((metric) => describe(metric).spec)) {',
    '      if (false) {',
    'r1: a Wiffi without feature takes a place',
  ),
  M(
    A,
    '    let oldest;\n    for (const mac of Object.keys(this.memory.devices)) {\n      if (this.created.has(this.ids(mac).device)) continue;',
    '    let oldest;\n    for (const mac of Object.keys(this.memory.devices)) {',
    'r1: a created Wiffi evicted',
  ),
  M(A, 'if (mono - heard >= TIMINGS.forgetAfter) {', 'if (false) {', 'r1: never forgotten'),
  M(
    A,
    '.filter(([, entry]) => Object.keys(entry.features).length > 0)',
    '.filter(() => true)',
    'r1: empty Wiffi offered',
    'an entry is created with a feature and /data drops empty ones: the filter is a backstop',
  ),
  M(
    A,
    'if (this.timersById[name] && this.dueAt[name] <= due) return;',
    'if (this.timersById[name]) return;',
    'r1: soon keeps the latest',
  ),
  M(
    S,
    '    if (Object.keys(features).length === 0) continue;\n',
    '',
    'r1: empty Wiffi read back from /data',
  ),
];
