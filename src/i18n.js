// -----------------------------------------------------------------------------
// The texts of the status shown in the Configuration screen, in English and
// French. Built from a snapshot of the app, bounded in length. Never a value
// typed by the user (an invalid entry is named by its position), never the
// content of a telegram.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const both = (en, fr) => ({ en, fr });

const list = (names) => {
  const shown = names.slice(0, LIMITS.statusNames).join(', ');
  return names.length > LIMITS.statusNames ? `${shown}…` : shown;
};

const plural = (n, en, fr) =>
  both(`${n} ${en}${n > 1 ? 's' : ''}`, `${n} ${fr}${n > 1 ? 's' : ''}`);

const REASONS = {
  source: both('sender not allowed', 'expéditeur non autorisé'),
  size: both('too large (over 64 KB)', 'trop gros (plus de 64 Ko)'),
  rate: both(
    'over the rate (60 a minute per address)',
    'au-delà du débit (60 par minute et par adresse)',
  ),
  total: both(
    'over the total rate (240 a minute for all the addresses)',
    'au-delà du débit total (240 par minute pour toutes les adresses)',
  ),
  nothing: both(
    'nothing publishable (a new Wiffi is kept only with a valid value of a supported unit)',
    'rien de publiable (un nouveau Wiffi n’est gardé qu’avec une valeur valable d’une unité prise en charge)',
  ),
  connections: both('over the connection limit', 'au-delà de la limite de connexions'),
  json: both(
    'not JSON (set the Wiffi to send JSON without header)',
    'pas du JSON (réglez le Wiffi sur l’envoi JSON sans en-tête)',
  ),
  shape: both('unknown shape', 'forme inconnue'),
  mac: both('no MAC address', 'sans adresse MAC'),
  devices: both(`more than ${LIMITS.devices} Wiffis`, `plus de ${LIMITS.devices} Wiffis`),
  stale: both(
    'older than 2 h (kept while the integration was stopped)',
    'plus de 2 h (gardé pendant l’arrêt de l’intégration)',
  ),
  order: both('older than the last one applied', 'plus ancien que le dernier appliqué'),
};

/**
 * @param {object} s - snapshot: { problem, unreadable, receiver: { status, port }, channelUp,
 *   devices: [{ label, alive, silentMinutes, mute: [] , changed: [] }], refused: { reason: { count, from } },
 *   unsupported: [], silenceMinutes }
 * @returns {{ connected: boolean, message: { en: string, fr: string } }}
 */
export function buildStatus(s) {
  const parts = [];
  let connected = false;
  if (s.problem) {
    parts.push(
      s.problem.kind === 'too-many'
        ? both(
            `Allowed senders: ${LIMITS.allowedAddresses} addresses at most; no telegram is accepted until it is corrected.`,
            `Expéditeurs autorisés : ${LIMITS.allowedAddresses} adresses au plus ; aucun télégramme n’est accepté avant correction.`,
          )
        : both(
            `Allowed senders: entry ${s.problem.index} is not an IP address (or a network a.b.c.d/16 to /32); no telegram is accepted until it is corrected.`,
            `Expéditeurs autorisés : l’entrée ${s.problem.index} n’est pas une adresse IP (ou un réseau a.b.c.d/16 à /32) ; aucun télégramme n’est accepté avant correction.`,
          ),
    );
  }
  if (s.receiver.status !== 'running') {
    parts.push(
      both(
        `The receiver of the telegrams is not running (${s.receiver.status}); tried again every 30 s.`,
        `Le récepteur des télégrammes ne tourne pas (${s.receiver.status}) ; nouvel essai toutes les 30 s.`,
      ),
    );
  } else if (!s.channelUp) {
    parts.push(
      both(
        'Connecting to the receiver of the telegrams…',
        'Connexion au récepteur des télégrammes…',
      ),
    );
  }
  const port = s.receiver.port ? String(s.receiver.port) : '?';
  const alive = s.devices.filter((d) => d.alive);
  const silent = s.devices.filter((d) => !d.alive);
  if (s.devices.length === 0) {
    parts.push(
      both(
        `No telegram received yet: set the Wiffi to send its JSON telegrams to the address of Gladys, port ${port}.`,
        `Aucun télégramme reçu pour l’instant : réglez le Wiffi pour envoyer ses télégrammes JSON à l’adresse de Gladys, port ${port}.`,
      ),
    );
  } else {
    connected = alive.length > 0 && !s.problem && s.receiver.status === 'running';
    parts.push(
      both(
        `${alive.length} of ${s.devices.length} Wiffi(s) heard in the last ${s.silenceMinutes} min (port ${port}).`,
        `${alive.length} Wiffi(s) sur ${s.devices.length} entendu(s) depuis ${s.silenceMinutes} min (port ${port}).`,
      ),
    );
  }
  for (const device of silent.slice(0, LIMITS.statusNames)) {
    parts.push(
      device.silentMinutes === null
        ? both(
            `${device.label}: silent since before the start.`,
            `${device.label} : muet depuis avant le démarrage.`,
          )
        : both(
            `${device.label}: silent for ${device.silentMinutes} min.`,
            `${device.label} : muet depuis ${device.silentMinutes} min.`,
          ),
    );
  }
  for (const device of alive) {
    if (device.mute.length > 0) {
      parts.push(
        both(
          `${device.label}: no valid value for ${s.silenceMinutes} min from ${list(device.mute)}.`,
          `${device.label} : aucune valeur valable depuis ${s.silenceMinutes} min pour ${list(device.mute)}.`,
        ),
      );
    }
    if (device.changed.length > 0) {
      parts.push(
        both(
          `${device.label}: unit changed, not published: ${list(device.changed)}.`,
          `${device.label} : unité changée, non publié : ${list(device.changed)}.`,
        ),
      );
    }
  }
  for (const [reason, entry] of Object.entries(s.refused)) {
    if (!entry.count || !Object.hasOwn(REASONS, reason)) continue;
    const n = plural(entry.count, 'telegram', 'télégramme');
    const from = entry.from ? ` (${entry.from})` : '';
    const refused = entry.count > 1 ? 'refusés' : 'refusé';
    parts.push(
      both(
        `${n.en} refused: ${REASONS[reason].en}${from}.`,
        `${n.fr} ${refused} : ${REASONS[reason].fr}${from}.`,
      ),
    );
  }
  if (s.unsupported.length > 0) {
    parts.push(
      both(
        `Not published (unit or kind not supported): ${list(s.unsupported)}.`,
        `Non publié (unité ou nature non prise en charge) : ${list(s.unsupported)}.`,
      ),
    );
  }
  if (s.unreadable) {
    parts.push(
      both(
        '/data/wiffi.json cannot be read: the Wiffis are remembered in memory only until it can (read again every 10 s).',
        '/data/wiffi.json est illisible : les Wiffis ne sont gardés qu’en mémoire jusqu’à ce qu’il le redevienne (relu toutes les 10 s).',
      ),
    );
  }
  const cut = (text) =>
    text.length > LIMITS.statusLength ? `${text.slice(0, LIMITS.statusLength - 1)}…` : text;
  return {
    connected,
    message: both(cut(parts.map((p) => p.en).join(' ')), cut(parts.map((p) => p.fr).join(' '))),
  };
}
