// MessagePayloadEnvelope: typed payload carried inside SendMessage / PushMessage
// / Publish payload bytes. Public API uses a discriminated union for metadata
// (matching the FlatBuffers MessageMetadata union one-to-one), and the canonical
// snake_case field names from privchat-protocol/protocol/content.fbs.

import * as flatbuffers from 'flatbuffers';
import {
  ContactCardMetadata as FbContactCardMetadata,
} from '../generated/privchat/protocol/contact-card-metadata.js';
import {
  FileMetadata as FbFileMetadata,
} from '../generated/privchat/protocol/file-metadata.js';
import {
  ForwardMessageRef as FbForwardMessageRef,
} from '../generated/privchat/protocol/forward-message-ref.js';
import {
  ForwardMetadata as FbForwardMetadata,
} from '../generated/privchat/protocol/forward-metadata.js';
import {
  ImageMetadata as FbImageMetadata,
} from '../generated/privchat/protocol/image-metadata.js';
import {
  LinkMetadata as FbLinkMetadata,
} from '../generated/privchat/protocol/link-metadata.js';
import {
  LocationMetadata as FbLocationMetadata,
} from '../generated/privchat/protocol/location-metadata.js';
import {
  MessageMetadata as FbMessageMetadataTag,
} from '../generated/privchat/protocol/message-metadata.js';
import {
  MessagePayloadEnvelope as FbMessagePayloadEnvelope,
} from '../generated/privchat/protocol/message-payload-envelope.js';
import {
  MessageSource as FbMessageSource,
} from '../generated/privchat/protocol/message-source.js';
import {
  StickerMetadata as FbStickerMetadata,
} from '../generated/privchat/protocol/sticker-metadata.js';
import {
  VideoMetadata as FbVideoMetadata,
} from '../generated/privchat/protocol/video-metadata.js';
import {
  VoiceMetadata as FbVoiceMetadata,
} from '../generated/privchat/protocol/voice-metadata.js';
import {
  bigintToIdString,
  bigintToOptionalIdString,
  idStringToBigint,
  optionalIdStringToBigint,
} from './ids.js';

// ----- Per-variant types -----

export interface ImageMetadata {
  type: 'image';
  file_id: string;
  url?: string;
  width: number;
  height: number;
  /** 缩略图独立 file_id（Scheme B：thumbnail_file_id -> file/get_url -> cek）。 */
  thumbnail_file_id?: string;
  /** legacy 明文缩略图 url；v1 加密无此字段。 */
  thumbnail_url?: string;
  file_name?: string;
}

export interface FileMetadata {
  type: 'file';
  file_id: string;
  /** 原文件名（展示用，随协议传输；不靠 file/get_url 异步查）。 */
  file_name?: string;
  /** 字节大小；0/缺省=未知。 */
  file_size?: number;
  mime_type?: string;
}

export interface VoiceMetadata {
  type: 'voice';
  file_id: string;
  /** Duration in seconds; clients round sub-1s up to 1. */
  duration: number;
  file_name?: string;
}

export interface VideoMetadata {
  type: 'video';
  file_id: string;
  duration: number;
  width: number;
  height: number;
  thumbnail_file_id?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  thumbnail_url?: string;
  file_name?: string;
}

export interface LocationMetadata {
  type: 'location';
  latitude: number;
  longitude: number;
  coordinate_system?: string;
  name?: string;
  address?: string;
  poi_id?: string;
  poi_source?: string;
  thumbnail_file_id?: string;
}

export interface ContactCardMetadata {
  type: 'contact_card';
  user_id: string;
}

export interface StickerMetadata {
  type: 'sticker';
  sticker_id: string;
  image_url: string;
}

export interface ForwardMessageRef {
  message_id?: string;
  content?: string;
  /** Opaque JSON bytes for vendor extras. Empty == none. */
  extra: Uint8Array;
}

export interface ForwardMetadata {
  type: 'forward';
  messages: ForwardMessageRef[];
}

export interface LinkMetadata {
  type: 'link';
  url: string;
  title?: string;
  description?: string;
  thumbnail_file_id?: string;
}

export type MessageMetadata =
  | ImageMetadata
  | FileMetadata
  | VoiceMetadata
  | VideoMetadata
  | LocationMetadata
  | ContactCardMetadata
  | StickerMetadata
  | ForwardMetadata
  | LinkMetadata;

export interface MessageSource {
  /** "search" | "group" | "card_share" | "qrcode" | "phone" */
  source_type: string;
  source_id: string;
}

export interface MessagePayloadEnvelope {
  content: string;
  /** None = text / system message. */
  metadata?: MessageMetadata;
  reply_to_message_id?: string;
  mentioned_user_ids: string[];
  message_source?: MessageSource;
}

// ----- Encode helpers per variant (return discriminator + offset) -----

function buildMetadata(
  builder: flatbuffers.Builder,
  m: MessageMetadata,
): { tag: FbMessageMetadataTag; offset: flatbuffers.Offset } {
  switch (m.type) {
    case 'image': {
      const url = m.url !== undefined ? builder.createString(m.url) : 0;
      const thumbUrl =
        m.thumbnail_url !== undefined ? builder.createString(m.thumbnail_url) : 0;
      const fileName = m.file_name !== undefined ? builder.createString(m.file_name) : 0;
      const off = FbImageMetadata.createImageMetadata(
        builder,
        idStringToBigint(m.file_id),
        url,
        m.width,
        m.height,
        optionalIdStringToBigint(m.thumbnail_file_id),
        thumbUrl,
        fileName,
      );
      return { tag: FbMessageMetadataTag.ImageMetadata, offset: off };
    }
    case 'file': {
      const fileName = m.file_name !== undefined ? builder.createString(m.file_name) : 0;
      const mimeType = m.mime_type !== undefined ? builder.createString(m.mime_type) : 0;
      FbFileMetadata.startFileMetadata(builder);
      FbFileMetadata.addFileId(builder, idStringToBigint(m.file_id));
      if (fileName) FbFileMetadata.addFileName(builder, fileName);
      FbFileMetadata.addFileSize(builder, BigInt(m.file_size ?? 0));
      if (mimeType) FbFileMetadata.addMimeType(builder, mimeType);
      const off = FbFileMetadata.endFileMetadata(builder);
      return { tag: FbMessageMetadataTag.FileMetadata, offset: off };
    }
    case 'voice': {
      const fileName = m.file_name !== undefined ? builder.createString(m.file_name) : 0;
      const off = FbVoiceMetadata.createVoiceMetadata(
        builder,
        idStringToBigint(m.file_id),
        m.duration,
        fileName,
      );
      return { tag: FbMessageMetadataTag.VoiceMetadata, offset: off };
    }
    case 'video': {
      const videoThumbUrl =
        m.thumbnail_url !== undefined ? builder.createString(m.thumbnail_url) : 0;
      const fileName = m.file_name !== undefined ? builder.createString(m.file_name) : 0;
      const off = FbVideoMetadata.createVideoMetadata(
        builder,
        idStringToBigint(m.file_id),
        m.duration,
        m.width,
        m.height,
        optionalIdStringToBigint(m.thumbnail_file_id),
        m.thumbnail_width ?? 0,
        m.thumbnail_height ?? 0,
        videoThumbUrl,
        fileName,
      );
      return { tag: FbMessageMetadataTag.VideoMetadata, offset: off };
    }
    case 'location': {
      const coordinateSystem =
        m.coordinate_system !== undefined ? builder.createString(m.coordinate_system) : 0;
      const name = m.name !== undefined ? builder.createString(m.name) : 0;
      const address = m.address !== undefined ? builder.createString(m.address) : 0;
      const poiId = m.poi_id !== undefined ? builder.createString(m.poi_id) : 0;
      const poiSource = m.poi_source !== undefined ? builder.createString(m.poi_source) : 0;
      const off = FbLocationMetadata.createLocationMetadata(
        builder,
        m.latitude,
        m.longitude,
        coordinateSystem,
        name,
        address,
        poiId,
        poiSource,
        optionalIdStringToBigint(m.thumbnail_file_id),
      );
      return { tag: FbMessageMetadataTag.LocationMetadata, offset: off };
    }
    case 'contact_card': {
      FbContactCardMetadata.startContactCardMetadata(builder);
      FbContactCardMetadata.addUserId(builder, idStringToBigint(m.user_id));
      const off = FbContactCardMetadata.endContactCardMetadata(builder);
      return { tag: FbMessageMetadataTag.ContactCardMetadata, offset: off };
    }
    case 'sticker': {
      const sid = builder.createString(m.sticker_id);
      const url = builder.createString(m.image_url);
      const off = FbStickerMetadata.createStickerMetadata(builder, sid, url);
      return { tag: FbMessageMetadataTag.StickerMetadata, offset: off };
    }
    case 'forward': {
      const refOffsets = m.messages.map((r) => {
        const contentOff = r.content !== undefined ? builder.createString(r.content) : 0;
        const extraOff = FbForwardMessageRef.createExtraVector(builder, r.extra);
        return FbForwardMessageRef.createForwardMessageRef(
          builder,
          optionalIdStringToBigint(r.message_id),
          contentOff,
          extraOff,
        );
      });
      const messagesVec = FbForwardMetadata.createMessagesVector(builder, refOffsets);
      const off = FbForwardMetadata.createForwardMetadata(builder, messagesVec);
      return { tag: FbMessageMetadataTag.ForwardMetadata, offset: off };
    }
    case 'link': {
      const url = builder.createString(m.url);
      const title = m.title !== undefined ? builder.createString(m.title) : 0;
      const desc = m.description !== undefined ? builder.createString(m.description) : 0;
      const off = FbLinkMetadata.createLinkMetadata(
        builder,
        url,
        title,
        desc,
        optionalIdStringToBigint(m.thumbnail_file_id),
      );
      return { tag: FbMessageMetadataTag.LinkMetadata, offset: off };
    }
  }
}

function buildMessageSource(
  builder: flatbuffers.Builder,
  src: MessageSource,
): flatbuffers.Offset {
  const t = builder.createString(src.source_type);
  const id = builder.createString(src.source_id);
  return FbMessageSource.createMessageSource(builder, t, id);
}

// ----- Decode helpers per variant -----

function decodeMetadata(
  tag: FbMessageMetadataTag,
  view: FbMessagePayloadEnvelope,
): MessageMetadata | undefined {
  switch (tag) {
    case FbMessageMetadataTag.NONE:
      return undefined;
    case FbMessageMetadataTag.ImageMetadata: {
      const m = view.metadata(new FbImageMetadata()) as FbImageMetadata | null;
      if (!m) return undefined;
      return {
        type: 'image',
        file_id: bigintToIdString(m.fileId()),
        url: m.url() ?? undefined,
        width: m.width(),
        height: m.height(),
        thumbnail_file_id: bigintToOptionalIdString(m.thumbnailFileId()),
        thumbnail_url: m.thumbnailUrl() ?? undefined,
        file_name: m.fileName() ?? undefined,
      };
    }
    case FbMessageMetadataTag.FileMetadata: {
      const m = view.metadata(new FbFileMetadata()) as FbFileMetadata | null;
      if (!m) return undefined;
      const size = Number(m.fileSize());
      return {
        type: 'file',
        file_id: bigintToIdString(m.fileId()),
        file_name: m.fileName() ?? undefined,
        file_size: size > 0 ? size : undefined,
        mime_type: m.mimeType() ?? undefined,
      };
    }
    case FbMessageMetadataTag.VoiceMetadata: {
      const m = view.metadata(new FbVoiceMetadata()) as FbVoiceMetadata | null;
      if (!m) return undefined;
      return {
        type: 'voice',
        file_id: bigintToIdString(m.fileId()),
        duration: m.duration(),
        file_name: m.fileName() ?? undefined,
      };
    }
    case FbMessageMetadataTag.VideoMetadata: {
      const m = view.metadata(new FbVideoMetadata()) as FbVideoMetadata | null;
      if (!m) return undefined;
      return {
        type: 'video',
        file_id: bigintToIdString(m.fileId()),
        duration: m.duration(),
        width: m.width(),
        height: m.height(),
        thumbnail_file_id: bigintToOptionalIdString(m.thumbnailFileId()),
        thumbnail_width: m.thumbnailWidth() === 0 ? undefined : m.thumbnailWidth(),
        thumbnail_height: m.thumbnailHeight() === 0 ? undefined : m.thumbnailHeight(),
        thumbnail_url: m.thumbnailUrl() ?? undefined,
        file_name: m.fileName() ?? undefined,
      };
    }
    case FbMessageMetadataTag.LocationMetadata: {
      const m = view.metadata(new FbLocationMetadata()) as FbLocationMetadata | null;
      if (!m) return undefined;
      return {
        type: 'location',
        latitude: m.latitude(),
        longitude: m.longitude(),
        coordinate_system: m.coordinateSystem() ?? undefined,
        name: m.name() ?? undefined,
        address: m.address() ?? undefined,
        poi_id: m.poiId() ?? undefined,
        poi_source: m.poiSource() ?? undefined,
        thumbnail_file_id: bigintToOptionalIdString(m.thumbnailFileId()),
      };
    }
    case FbMessageMetadataTag.ContactCardMetadata: {
      const m = view.metadata(new FbContactCardMetadata()) as FbContactCardMetadata | null;
      if (!m) return undefined;
      return { type: 'contact_card', user_id: bigintToIdString(m.userId()) };
    }
    case FbMessageMetadataTag.StickerMetadata: {
      const m = view.metadata(new FbStickerMetadata()) as FbStickerMetadata | null;
      if (!m) return undefined;
      return {
        type: 'sticker',
        sticker_id: m.stickerId() ?? '',
        image_url: m.imageUrl() ?? '',
      };
    }
    case FbMessageMetadataTag.ForwardMetadata: {
      const m = view.metadata(new FbForwardMetadata()) as FbForwardMetadata | null;
      if (!m) return undefined;
      const messages: ForwardMessageRef[] = [];
      for (let i = 0; i < m.messagesLength(); i++) {
        const r = m.messages(i);
        if (!r) continue;
        messages.push({
          message_id: bigintToOptionalIdString(r.messageId()),
          content: r.content() ?? undefined,
          extra: r.extraArray() ?? new Uint8Array(0),
        });
      }
      return { type: 'forward', messages };
    }
    case FbMessageMetadataTag.LinkMetadata: {
      const m = view.metadata(new FbLinkMetadata()) as FbLinkMetadata | null;
      if (!m) return undefined;
      return {
        type: 'link',
        url: m.url() ?? '',
        title: m.title() ?? undefined,
        description: m.description() ?? undefined,
        thumbnail_file_id: bigintToOptionalIdString(m.thumbnailFileId()),
      };
    }
    default:
      return undefined;
  }
}

// ----- Public encode / decode -----

export function encodeMessagePayloadEnvelope(env: MessagePayloadEnvelope): Uint8Array {
  const builder = new flatbuffers.Builder(512);

  const contentOff = builder.createString(env.content);
  const meta = env.metadata ? buildMetadata(builder, env.metadata) : null;
  const mentionsVec = FbMessagePayloadEnvelope.createMentionedUserIdsVector(
    builder,
    env.mentioned_user_ids.map(idStringToBigint),
  );
  const sourceOff = env.message_source ? buildMessageSource(builder, env.message_source) : 0;

  FbMessagePayloadEnvelope.startMessagePayloadEnvelope(builder);
  FbMessagePayloadEnvelope.addContent(builder, contentOff);
  if (meta) {
    FbMessagePayloadEnvelope.addMetadataType(builder, meta.tag);
    FbMessagePayloadEnvelope.addMetadata(builder, meta.offset);
  }
  FbMessagePayloadEnvelope.addReplyToMessageId(
    builder,
    optionalIdStringToBigint(env.reply_to_message_id),
  );
  FbMessagePayloadEnvelope.addMentionedUserIds(builder, mentionsVec);
  if (sourceOff) FbMessagePayloadEnvelope.addMessageSource(builder, sourceOff);
  const offset = FbMessagePayloadEnvelope.endMessagePayloadEnvelope(builder);
  builder.finish(offset);
  return builder.asUint8Array();
}

export function decodeMessagePayloadEnvelope(bytes: Uint8Array): MessagePayloadEnvelope {
  const view = FbMessagePayloadEnvelope.getRootAsMessagePayloadEnvelope(
    new flatbuffers.ByteBuffer(bytes),
  );
  const metadata = decodeMetadata(view.metadataType(), view);

  const mentioned_user_ids: string[] = [];
  for (let i = 0; i < view.mentionedUserIdsLength(); i++) {
    const id = view.mentionedUserIds(i);
    if (id !== null) mentioned_user_ids.push(bigintToIdString(id));
  }

  const sourceView = view.messageSource();
  const message_source: MessageSource | undefined = sourceView
    ? {
        source_type: sourceView.sourceType() ?? '',
        source_id: sourceView.sourceId() ?? '',
      }
    : undefined;

  return {
    content: view.content() ?? '',
    metadata,
    reply_to_message_id: bigintToOptionalIdString(view.replyToMessageId()),
    mentioned_user_ids,
    message_source,
  };
}
