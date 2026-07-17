import * as flatbuffers from 'flatbuffers';
import { CanonicalTimelineEvent as FbCanonicalTimelineEvent } from '../generated/privchat/protocol/canonical-timeline-event.js';
import { NewMessageEvent as FbNewMessageEvent } from '../generated/privchat/protocol/new-message-event.js';
import { ReactionChangeEvent as FbReactionChangeEvent } from '../generated/privchat/protocol/reaction-change-event.js';
import { ReactionOperation as FbReactionOperation } from '../generated/privchat/protocol/reaction-operation.js';
import { RevokeEvent as FbRevokeEvent } from '../generated/privchat/protocol/revoke-event.js';
import { TimelineEventPayload as FbTimelineEventPayload } from '../generated/privchat/protocol/timeline-event-payload.js';
import { contentTypeFromWireTag, contentTypeToWireTag, decodeContentTypeName } from '../content-type.js';
import { decodeLegacyMessageEnvelope } from '../message-content.js';
import {
  buildMessagePayloadEnvelopeTable,
  decodeMessagePayloadEnvelopeTable,
  type MessageMetadata,
  type MessagePayloadEnvelope,
} from './payload.js';

export const CANONICAL_TIMELINE_EVENT_SCHEMA_V1 = 1;

export type CanonicalTimelineEvent =
  | { type: 'new_message'; message_type: number; payload: MessagePayloadEnvelope }
  | {
      type: 'revoke';
      target_server_message_id: string;
      revoked_by: string;
      revoked_at: number;
    }
  | {
      type: 'reaction_change';
      target_server_message_id: string;
      actor_id: string;
      emoji: string;
      operation: 'add' | 'remove';
    };

export type CanonicalEventSource =
  | 'canonical'
  | 'legacy_no_canonical'
  | 'legacy_unknown_version'
  | 'legacy_decode_error';

export interface CanonicalEventCommit {
  server_msg_id: string;
  message_type: string;
  content: unknown;
  server_timestamp: number;
  sender_id: string;
  event_schema_version?: number;
  canonical_event?: string;
}

export interface CanonicalEventResolution {
  event?: CanonicalTimelineEvent;
  source: CanonicalEventSource;
  canonical_legacy_mismatch: boolean;
  canonical_decode_error: boolean;
}

let mismatchCount = 0;
let decodeErrorCount = 0;

export function canonicalEventMetricSnapshot(): {
  canonical_legacy_mismatch: number;
  canonical_decode_error: number;
} {
  return {
    canonical_legacy_mismatch: mismatchCount,
    canonical_decode_error: decodeErrorCount,
  };
}

export function encodeCanonicalTimelineEvent(event: CanonicalTimelineEvent): Uint8Array {
  const builder = new flatbuffers.Builder(512);
  let tag: FbTimelineEventPayload;
  let payload: flatbuffers.Offset;
  switch (event.type) {
    case 'new_message': {
      const envelope = buildMessagePayloadEnvelopeTable(builder, event.payload);
      FbNewMessageEvent.startNewMessageEvent(builder);
      FbNewMessageEvent.addMessageType(builder, event.message_type);
      FbNewMessageEvent.addPayload(builder, envelope);
      payload = FbNewMessageEvent.endNewMessageEvent(builder);
      tag = FbTimelineEventPayload.NewMessageEvent;
      break;
    }
    case 'revoke': {
      payload = FbRevokeEvent.createRevokeEvent(
        builder,
        BigInt(event.target_server_message_id),
        BigInt(event.revoked_by),
        BigInt(event.revoked_at),
      );
      tag = FbTimelineEventPayload.RevokeEvent;
      break;
    }
    case 'reaction_change': {
      const emoji = builder.createString(event.emoji);
      payload = FbReactionChangeEvent.createReactionChangeEvent(
        builder,
        BigInt(event.target_server_message_id),
        BigInt(event.actor_id),
        emoji,
        event.operation === 'remove' ? FbReactionOperation.Remove : FbReactionOperation.Add,
      );
      tag = FbTimelineEventPayload.ReactionChangeEvent;
      break;
    }
  }
  const root = FbCanonicalTimelineEvent.createCanonicalTimelineEvent(builder, tag, payload);
  builder.finish(root);
  return builder.asUint8Array();
}

export function decodeCanonicalTimelineEvent(bytes: Uint8Array): CanonicalTimelineEvent {
  const view = FbCanonicalTimelineEvent.getRootAsCanonicalTimelineEvent(
    new flatbuffers.ByteBuffer(bytes),
  );
  switch (view.payloadType()) {
    case FbTimelineEventPayload.NewMessageEvent: {
      const event = view.payload(new FbNewMessageEvent()) as FbNewMessageEvent | null;
      const payload = event?.payload();
      if (!event || !payload) throw new Error('canonical new_message payload missing');
      if (contentTypeFromWireTag(event.messageType()) === 'unknown') {
        throw new Error(`unknown canonical message_type ${event.messageType()}`);
      }
      return {
        type: 'new_message',
        message_type: event.messageType(),
        payload: decodeMessagePayloadEnvelopeTable(payload),
      };
    }
    case FbTimelineEventPayload.RevokeEvent: {
      const event = view.payload(new FbRevokeEvent()) as FbRevokeEvent | null;
      if (!event) throw new Error('canonical revoke payload missing');
      return {
        type: 'revoke',
        target_server_message_id: event.targetServerMessageId().toString(),
        revoked_by: event.revokedBy().toString(),
        revoked_at: Number(event.revokedAt()),
      };
    }
    case FbTimelineEventPayload.ReactionChangeEvent: {
      const event = view.payload(new FbReactionChangeEvent()) as FbReactionChangeEvent | null;
      if (!event) throw new Error('canonical reaction_change payload missing');
      if (event.operation() === FbReactionOperation.Unknown) {
        throw new Error('canonical reaction operation missing');
      }
      return {
        type: 'reaction_change',
        target_server_message_id: event.targetServerMessageId().toString(),
        actor_id: event.actorId().toString(),
        emoji: event.emoji() ?? '',
        operation: event.operation() === FbReactionOperation.Remove ? 'remove' : 'add',
      };
    }
    default:
      throw new Error('unknown canonical timeline event');
  }
}

export function resolveCanonicalTimelineEvent(
  commit: CanonicalEventCommit,
): CanonicalEventResolution {
  const legacy = canonicalFromLegacy(commit);
  if (commit.event_schema_version === undefined) {
    return resolution(legacy, 'legacy_no_canonical');
  }
  if (commit.event_schema_version !== CANONICAL_TIMELINE_EVENT_SCHEMA_V1) {
    return resolution(legacy, 'legacy_unknown_version');
  }
  if (!commit.canonical_event) {
    decodeErrorCount += 1;
    return resolution(legacy, 'legacy_decode_error', false, true);
  }
  try {
    const canonical = decodeCanonicalTimelineEvent(decodeBase64(commit.canonical_event));
    const mismatch = legacy !== undefined && !eventsEqual(canonical, legacy);
    if (mismatch) mismatchCount += 1;
    return resolution(canonical, 'canonical', mismatch, false);
  } catch {
    decodeErrorCount += 1;
    return resolution(legacy, 'legacy_decode_error', false, true);
  }
}

function resolution(
  event: CanonicalTimelineEvent | undefined,
  source: CanonicalEventSource,
  canonical_legacy_mismatch = false,
  canonical_decode_error = false,
): CanonicalEventResolution {
  return { event, source, canonical_legacy_mismatch, canonical_decode_error };
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function canonicalFromLegacy(commit: CanonicalEventCommit): CanonicalTimelineEvent | undefined {
  if (['message.revoke', 'message_extra', 'message_ext'].includes(commit.message_type)) {
    const content = asObject(commit.content);
    return {
      type: 'revoke',
      target_server_message_id: idValue(content.message_id) ?? commit.server_msg_id,
      revoked_by: idValue(content.revoked_by) ?? commit.sender_id,
      revoked_at: numberValue(content.revoked_at) ?? commit.server_timestamp,
    };
  }
  if (['message_reaction', 'reaction', 'message.reaction'].includes(commit.message_type)) {
    const content = asObject(commit.content);
    const target = idValue(content.message_id);
    const emoji = typeof content.emoji === 'string' ? content.emoji : undefined;
    if (!target || !emoji) return undefined;
    return {
      type: 'reaction_change',
      target_server_message_id: target,
      actor_id: idValue(content.uid) ?? commit.sender_id,
      emoji,
      operation: content.deleted === true ? 'remove' : 'add',
    };
  }

  const name = decodeContentTypeName(commit.message_type);
  if (name === 'unknown') return undefined;
  const decodedEnvelope = decodeLegacyMessageEnvelope(commit.content);
  const content = decodedEnvelope?.raw ?? asObject(commit.content);
  const display =
    decodedEnvelope !== undefined
      ? decodedEnvelope.content
      : typeof commit.content === 'string'
      ? commit.content
      : typeof content.text === 'string'
        ? content.text
        : typeof content.content === 'string'
          ? content.content
          : JSON.stringify(commit.content);
  const envelope: MessagePayloadEnvelope = {
    content: display,
    mentioned_user_ids: Array.isArray(content.mentioned_user_ids)
      ? content.mentioned_user_ids.map(String)
      : [],
  };
  const metadata = content.metadata ?? (name === 'text' || name === 'system' ? undefined : content);
  if (metadata && typeof metadata === 'object' && name !== 'red_packet' && name !== 'money_transfer') {
    envelope.metadata = { type: name, ...(metadata as object) } as MessageMetadata;
  }
  const reply = idValue(content.reply_to_message_id);
  if (reply) envelope.reply_to_message_id = reply;
  if (content.message_source && typeof content.message_source === 'object') {
    const source = content.message_source as Record<string, unknown>;
    if (typeof source.type === 'string' && typeof source.source_id === 'string') {
      envelope.message_source = { source_type: source.type, source_id: source.source_id };
    }
  }
  return { type: 'new_message', message_type: contentTypeToWireTag(name), payload: envelope };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function idValue(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventsEqual(a: CanonicalTimelineEvent, b: CanonicalTimelineEvent): boolean {
  return JSON.stringify(a, jsonReplacer) === JSON.stringify(b, jsonReplacer);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value;
}
