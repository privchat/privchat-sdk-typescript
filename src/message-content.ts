import { parseRpcJson } from './codec/safe-json.js';
import type { ContentTypeName } from './content-type.js';
import type { MessageMetadata, MessagePayloadEnvelope } from './codec/payload.js';

const LEGACY_ENVELOPE_MARKERS = [
  'metadata',
  'reply_to_message_id',
  'mentioned_user_ids',
  'message_source',
] as const;

export interface LegacyMessageEnvelope {
  content: string;
  raw: Record<string, unknown>;
}

export type MessageTextEntityType = 'mention' | 'url' | 'phone';

export interface MessageTextEntity {
  type: MessageTextEntityType;
  /** UTF-16 offsets, matching JavaScript string slicing and DOM ranges. */
  start: number;
  end: number;
  text: string;
  value: string;
  user_id?: string;
}

export interface SystemMessageRef {
  type: string;
  target_id?: string;
  text?: string;
}

export interface MoneyMessageSnapshot {
  ref_id?: string;
  title?: string;
  summary?: string;
  status?: string;
  amount_text?: string;
  scene?: string;
  packet_type?: number;
}

interface MessageContentBase {
  /** Safe display text/caption. This is never a protocol JSON envelope. */
  text: string;
  entities: readonly MessageTextEntity[];
  reply_to_message_id?: string;
  mentioned_user_ids: readonly string[];
}

export type MessageContent =
  | (MessageContentBase & { kind: 'text' })
  | (MessageContentBase & {
      kind: 'system';
      template?: string;
      refs: readonly SystemMessageRef[];
    })
  | (MessageContentBase & {
      kind: 'red_packet' | 'money_transfer';
      money: MoneyMessageSnapshot;
    })
  | (MessageContentBase & {
      kind: Exclude<ContentTypeName, 'text' | 'system' | 'red_packet' | 'money_transfer'>;
      metadata?: MessageMetadata;
    });

export interface ProjectMessageContentInput {
  content_type: ContentTypeName;
  content: unknown;
  envelope?: MessagePayloadEnvelope;
  reply_to_message_id?: string;
  mentioned_user_ids?: readonly string[];
}

/** Decode protocol-owned legacy JSON without consuming ordinary JSON text. */
export function decodeLegacyMessageEnvelope(
  value: unknown,
): LegacyMessageEnvelope | undefined {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      candidate = parseRpcJson<unknown>(trimmed);
    } catch {
      return undefined;
    }
  }

  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.content !== 'string') return undefined;
  if (!LEGACY_ENVELOPE_MARKERS.some((key) => Object.hasOwn(raw, key))) {
    return undefined;
  }
  return { content: raw.content, raw };
}

/** Display text normalization belongs to the SDK boundary, never the UI. */
export function normalizeMessageDisplayContent(value: unknown): string {
  if (typeof value !== 'string') return '';
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const decoded = decodeLegacyMessageEnvelope(current);
    if (!decoded || decoded.content === current) break;
    current = decoded.content;
  }
  return current;
}

/**
 * The only public projection from transport/storage content into UI-safe data.
 * Renderers consume MessageContent and must never parse MessageRecord.content.
 */
export function projectMessageContent(input: ProjectMessageContentInput): MessageContent {
  const legacy = decodeLegacyMessageEnvelope(input.content);
  const raw = legacy?.raw;
  // MessageRecord.content is the SDK-normalized display body. The payload
  // envelope enriches it with reply/mention/metadata fields, but must never
  // overwrite it: raw UTF-8 text can be misread as a structurally plausible
  // empty FlatBuffers table by generated readers. History has no raw payload,
  // which is why the old bug disappeared after reopening a conversation.
  const text = normalizeMessageDisplayContent(
    typeof input.content === 'string' ? input.content : input.envelope?.content,
  );
  const mentionedUserIds = uniqueStrings(
    input.envelope?.mentioned_user_ids ??
      input.mentioned_user_ids ??
      idList(raw?.mentioned_user_ids),
  );
  const replyTo =
    input.envelope?.reply_to_message_id ??
    input.reply_to_message_id ??
    idString(raw?.reply_to_message_id);
  const base = (safeText: string): MessageContentBase => ({
    text: safeText,
    entities: scanMessageTextEntities(safeText, mentionedUserIds),
    reply_to_message_id: replyTo,
    mentioned_user_ids: mentionedUserIds,
  });

  if (input.content_type === 'text') return { ...base(text), kind: 'text' };
  if (input.content_type === 'system') {
    const system = parseSystemMessage(text);
    const safeText = system?.template ?? (looksLikeJson(text) ? '' : text);
    return { ...base(safeText), kind: 'system', template: system?.template, refs: system?.refs ?? [] };
  }
  if (input.content_type === 'red_packet' || input.content_type === 'money_transfer') {
    const money = parseMoneySnapshot(text);
    return {
      ...base(money.title ?? money.summary ?? ''),
      kind: input.content_type,
      money,
    };
  }
  return {
    ...base(looksLikeJson(text) ? '' : text),
    kind: input.content_type,
    metadata: input.envelope?.metadata,
  };
}

/** Scan text once in the SDK so Web/H5 renderers share identical semantics. */
export function scanMessageTextEntities(
  text: string,
  mentionedUserIds: readonly string[] = [],
): readonly MessageTextEntity[] {
  const candidates: MessageTextEntity[] = [];
  collectMatches(candidates, text, /\bhttps?:\/\/[^\s<>{}\[\]"']+/giu, 'url', (raw) => raw);
  collectMatches(
    candidates,
    text,
    /(?<![\d+])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu,
    'phone',
    (raw) => raw.replace(/[\s-]/g, ''),
  );

  let mentionIndex = 0;
  for (const match of text.matchAll(/@[\p{L}\p{N}_-]+/gu)) {
    const start = match.index;
    const raw = match[0];
    if (start === undefined || raw === undefined) continue;
    candidates.push({
      type: 'mention',
      start,
      end: start + raw.length,
      text: raw,
      value: raw.slice(1),
      user_id: mentionedUserIds[mentionIndex],
    });
    mentionIndex += 1;
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: MessageTextEntity[] = [];
  for (const candidate of candidates) {
    if (accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) continue;
    accepted.push(candidate);
  }
  return accepted;
}

export function messageContentText(content: MessageContent): string {
  return content.text;
}

function collectMatches(
  target: MessageTextEntity[],
  text: string,
  pattern: RegExp,
  type: 'url' | 'phone',
  value: (raw: string) => string,
): void {
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const raw = match[0];
    if (start === undefined || raw === undefined) continue;
    target.push({ type, start, end: start + raw.length, text: raw, value: value(raw) });
  }
}

function parseObject(value: string): Record<string, unknown> | undefined {
  if (!value.trimStart().startsWith('{')) return undefined;
  try {
    const parsed = parseRpcJson<unknown>(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function parseSystemMessage(value: string):
  | { template: string; refs: readonly SystemMessageRef[] }
  | undefined {
  const raw = parseObject(value);
  if (typeof raw?.template !== 'string') return undefined;
  const refs = Array.isArray(raw.refs)
    ? raw.refs.flatMap((item): SystemMessageRef[] => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
        const ref = item as Record<string, unknown>;
        return [{
          type: typeof ref.type === 'string' ? ref.type : '',
          target_id: idString(ref.target_id),
          text: typeof ref.text === 'string' ? ref.text : undefined,
        }];
      })
    : [];
  return { template: raw.template, refs };
}

function parseMoneySnapshot(value: string): MoneyMessageSnapshot {
  const raw = parseObject(value);
  if (!raw) return {};
  return {
    ref_id: idString(raw.redPacketId) ?? idString(raw.transferId),
    title: stringField(raw.title),
    summary: stringField(raw.summary),
    status: stringField(raw.status),
    amount_text: stringField(raw.amountText),
    scene: stringField(raw.scene),
    packet_type: typeof raw.type === 'number' ? raw.type : undefined,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => idString(item) ?? []) : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}
