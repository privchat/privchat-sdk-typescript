// Canonical content-type mapping — the single source of truth for
// converting between the FlatBuffers wire tag (`protocol::
// ContentMessageType`, u32) and the word-form discriminant the server's
// JSON wire emits (`MessageType::as_str()`).
//
// Cache contract: `MessageRecord.message_type` stores the WORD form
// ('text' / 'image' / ...). All SDK write paths (push absorb, local echo,
// outbox reconstruction, history, sync) converge here. Decoders stay
// tolerant of the legacy decimal-string form ('0'..'10') because rows
// persisted in IndexedDB before this convergence still carry it.

export type ContentTypeName =
  | 'text'
  | 'voice'
  | 'image'
  | 'video'
  | 'file'
  | 'system'
  | 'sticker'
  | 'contact_card'
  | 'location'
  | 'link'
  | 'forward'
  | 'red_packet'
  | 'money_transfer'
  | 'unknown';

const BY_TAG: readonly ContentTypeName[] = [
  'text', // 0
  'voice', // 1
  'image', // 2
  'video', // 3
  'file', // 4
  'system', // 5
  'sticker', // 6
  'contact_card', // 7
  'location', // 8
  'link', // 9
  'forward', // 10
  'red_packet', // 11 — server-injected money card (RP-12)
  'money_transfer', // 12 — server-injected money card (RP-12)
];

const TAG_BY_NAME: ReadonlyMap<string, number> = new Map(
  BY_TAG.map((name, tag) => [name, tag]),
);

const NAMES: ReadonlySet<string> = new Set<string>([...BY_TAG, 'unknown']);

/** Wire u32 tag → word form. Unknown tags → 'unknown'. */
export function contentTypeFromWireTag(tag: number): ContentTypeName {
  return BY_TAG[tag] ?? 'unknown';
}

/** Word form → wire u32 tag. 'unknown' (and anything unrecognized)
 *  falls back to 0 (Text) — the conservative wire default. */
export function contentTypeToWireTag(name: string): number {
  return TAG_BY_NAME.get(name) ?? 0;
}

/**
 * Decode a cache `message_type` value into a `ContentTypeName`. Accepts
 * BOTH representations that exist in persisted data:
 *   - word form ('text' / 'image' / …) — the canonical cache form
 *   - decimal-string of the wire tag ('0'..'10') — legacy rows written
 *     by the push / outbox / local-echo paths before convergence
 * Anything else → 'unknown'.
 */
export function decodeContentTypeName(raw: string): ContentTypeName {
  if (NAMES.has(raw)) return raw as ContentTypeName;
  const tag = Number(raw);
  if (Number.isInteger(tag) && tag >= 0 && tag < BY_TAG.length) {
    return BY_TAG[tag] ?? 'unknown';
  }
  return 'unknown';
}
