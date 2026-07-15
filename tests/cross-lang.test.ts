// Cross-language fixture verification.
//
// Reads .bin files produced by `cargo run --example cross_lang_fixtures`
// (Rust → TS direction), and writes TS-encoded copies for the Rust verifier
// to consume (`cargo run --example cross_lang_fixtures verify`, TS → Rust).
//
// Tests are skipped when from-rust/ is missing so a fresh checkout still
// passes — run the Rust dumper first.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeAuthorizationRequest,
  decodeAuthorizationResponse,
  decodeCanonicalTimelineEvent,
  decodeMessagePayloadEnvelope,
  decodePingRequest,
  decodePongResponse,
  decodePushBatchRequest,
  decodePushMessageRequest,
  decodeSendMessageRequest,
  decodeSendMessageResponse,
  decodeSubscribeRequest,
  decodeSubscribeResponse,
  encodeAuthorizationRequest,
  encodeAuthorizationResponse,
  encodeCanonicalTimelineEvent,
  encodeMessagePayloadEnvelope,
  encodePingRequest,
  encodePongResponse,
  encodePushBatchRequest,
  encodePushMessageRequest,
  encodeSendMessageRequest,
  encodeSendMessageResponse,
  encodeSubscribeRequest,
  encodeSubscribeResponse,
  type AuthorizationRequest,
  type AuthorizationResponse,
  type CanonicalTimelineEvent,
  type MessagePayloadEnvelope,
  type PushBatchRequest,
  type PushMessageRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type SubscribeRequest,
  type SubscribeResponse,
} from '../src/index.js';

const FIXTURES_DIR = join(__dirname, 'fixtures');
const FROM_RUST = join(FIXTURES_DIR, 'from-rust');
const FROM_TS = join(FIXTURES_DIR, 'from-ts');

const HAS_RUST_FIXTURES = existsSync(FROM_RUST);

if (!HAS_RUST_FIXTURES) {
  // eslint-disable-next-line no-console
  console.warn(
    `[cross-lang] from-rust/ missing — run \`cargo run --example cross_lang_fixtures\` ` +
      `from privchat-protocol/. Skipping cross-language tests.`,
  );
}

const readBin = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FROM_RUST, `${name}.bin`)));

const writeBin = (name: string, bytes: Uint8Array): void => {
  if (!existsSync(FROM_TS)) mkdirSync(FROM_TS, { recursive: true });
  writeFileSync(join(FROM_TS, `${name}.bin`), bytes);
};

// ------------------------------------------------------------------
// Canonical TS fixtures — must mirror cross_lang_fixtures.rs exactly.
// ------------------------------------------------------------------

const CANON = {
  ping: { timestamp: 1_714_680_000_000 },
  pong: { timestamp: 1_714_680_001_500 },

  subscribe_request: {
    setting: 0x07,
    local_message_id: '42',
    channel_id: '900710001',
    channel_type: 2,
    action: 1,
    param: 'history=true&limit=20',
  } satisfies SubscribeRequest,

  subscribe_response: {
    local_message_id: '42',
    channel_id: '900710001',
    channel_type: 2,
    action: 1,
    reason_code: 0,
  } satisfies SubscribeResponse,

  send_request: {
    setting: { need_receipt: true, signal: 0 },
    client_seq: 42,
    local_message_id: '900710001',
    stream_no: '',
    channel_id: '12345',
    message_type: 0,
    expire: 0,
    from_uid: '999',
    topic: '',
    payload: new TextEncoder().encode('{"content":"hi"}'),
  } satisfies SendMessageRequest,

  send_response: {
    client_seq: 42,
    server_message_id: '700110001',
    message_seq: 100,
    reason_code: 0,
  } satisfies SendMessageResponse,

  push_message: {
    setting: { need_receipt: true, signal: 0 },
    msg_key: 'k-1',
    server_message_id: '700110001',
    message_seq: 100,
    local_message_id: '900710001',
    stream_no: '',
    stream_seq: 0,
    stream_flag: 0,
    timestamp: 1_714_680_000,
    channel_id: '12345',
    channel_type: 1,
    message_type: 0,
    expire: 0,
    topic: '',
    from_uid: '999',
    payload: new TextEncoder().encode('{"content":"hi"}'),
    deleted: false,
  } satisfies PushMessageRequest,

  push_batch: {
    messages: [
      ['k-1', '1', 1, false],
      ['k-2', '2', 2, false],
      ['k-3', '3', 3, true],
    ].map(([msg_key, server_message_id, message_seq, deleted]) => ({
      setting: { need_receipt: true, signal: 0 },
      msg_key: msg_key as string,
      server_message_id: server_message_id as string,
      message_seq: message_seq as number,
      local_message_id: '900710001',
      stream_no: '',
      stream_seq: 0,
      stream_flag: 0,
      timestamp: 1_714_680_000,
      channel_id: '12345',
      channel_type: 1,
      message_type: 0,
      expire: 0,
      topic: '',
      from_uid: '999',
      payload: new TextEncoder().encode('{"content":"hi"}'),
      deleted: deleted as boolean,
    })),
  } satisfies PushBatchRequest,

  auth_request: {
    auth_type: 'jwt',
    auth_token: 'eyJhbGciOi...',
    client_info: {
      client_type: 'web',
      version: '0.1.0',
      os: 'macOS',
      os_version: '15.0',
      device_model: 'MacBookPro18,1',
      app_package: 'com.privchat.web',
    },
    device_info: {
      device_id: 'dev-123',
      device_type: 'web',
      app_id: 'app-1',
      push_token: 'fcm-token',
      push_channel: 'fcm',
      device_name: 'Chrome 130',
      device_model: undefined,
      os_version: '15.0',
      app_version: '0.1.0',
      manufacturer: 'Apple',
      device_fingerprint: 'fp-abc',
    },
    protocol_version: '1.0',
    properties: { region: 'us-west', tenant: 'demo' },
  } satisfies AuthorizationRequest,

  auth_response: {
    success: true,
    session_id: 'sess-1',
    user_id: '900710001',
    connection_id: 'conn-1',
    server_info: {
      version: '1.0.0',
      name: 'privchat',
      features: ['fb', 'multi-device'],
      max_message_size: 4_194_304,
      connection_timeout: 60,
    },
    heartbeat_interval: 30,
  } satisfies AuthorizationResponse,

  payload_text: {
    content: 'hello world',
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_image: {
    content: '',
    metadata: {
      type: 'image',
      file_id: '500110001',
      url: 'https://cdn.example/img.jpg',
      width: 1920,
      height: 1080,
      thumbnail_file_id: '500110002',
      thumbnail_url: 'https://cdn.example/img-thumb.jpg',
      file_name: 'photo.jpg',
    },
    reply_to_message_id: '700110001',
    mentioned_user_ids: ['1001', '1002'],
    message_source: { source_type: 'group', source_id: 'g-42' },
  } satisfies MessagePayloadEnvelope,

  payload_file: {
    content: '',
    metadata: {
      type: 'file',
      file_id: '500110003',
      file_name: 'report.pdf',
      file_size: 1_048_576,
      mime_type: 'application/pdf',
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_voice: {
    content: '',
    metadata: {
      type: 'voice',
      file_id: '500110004',
      duration: 7,
      file_name: 'voice.m4a',
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_video: {
    content: '',
    metadata: {
      type: 'video',
      file_id: '500110005',
      duration: 30,
      width: 1280,
      height: 720,
      thumbnail_file_id: '500110006',
      thumbnail_width: 640,
      thumbnail_height: 360,
      thumbnail_url: 'https://cdn.example/video-thumb.jpg',
      file_name: 'clip.mp4',
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_location: {
    content: '',
    metadata: {
      type: 'location',
      latitude: 31.240018,
      longitude: 121.490317,
      coordinate_system: 'gcj02',
      name: 'The Bund',
      address: 'Zhongshan East 1st Road, Shanghai',
      poi_id: 'amap-poi-001',
      poi_source: 'amap',
      thumbnail_file_id: '500110007',
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_contact: {
    content: '',
    metadata: { type: 'contact_card', user_id: '900710002' },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_sticker: {
    content: '',
    metadata: {
      type: 'sticker',
      sticker_id: 'pack-1/sticker-3',
      image_url: 'https://cdn.example/s.png',
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_forward: {
    content: '',
    metadata: {
      type: 'forward',
      messages: [
        { message_id: '700110001', content: 'hi', extra: new Uint8Array(0) },
        { content: 'inline only', extra: new TextEncoder().encode('{"v":1}') },
        { message_id: '700110002', extra: new Uint8Array(0) },
      ],
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  payload_link: {
    content: '',
    metadata: {
      type: 'link',
      url: 'https://example.com/a',
      title: 'Example',
      description: 'A link',
      thumbnail_file_id: '500110008',
    },
    mentioned_user_ids: [],
  } satisfies MessagePayloadEnvelope,

  timeline_new_message: {
    type: 'new_message',
    message_type: 2,
    payload: {
      content: '',
      metadata: {
        type: 'image',
        file_id: '9007199254740993',
        width: 1920,
        height: 1080,
        file_name: 'large-id.jpg',
      },
      mentioned_user_ids: ['9007199254740995'],
    },
  } satisfies CanonicalTimelineEvent,

  timeline_revoke: {
    type: 'revoke',
    target_server_message_id: '9007199254740997',
    revoked_by: '9007199254740999',
    revoked_at: 1_714_680_000_000,
  } satisfies CanonicalTimelineEvent,

  timeline_reaction: {
    type: 'reaction_change',
    target_server_message_id: '9007199254741001',
    actor_id: '9007199254741003',
    emoji: 'thumbs-up',
    operation: 'remove',
  } satisfies CanonicalTimelineEvent,
};

// ------------------------------------------------------------------
// Read Rust .bin → decode → assert == canonical TS object
// Encode canonical TS object → write from-ts/*.bin
// ------------------------------------------------------------------

describe.skipIf(!HAS_RUST_FIXTURES)('cross-language fixtures', () => {
  it('ping', () => {
    expect(decodePingRequest(readBin('ping'))).toEqual(CANON.ping);
    writeBin('ping', encodePingRequest(CANON.ping));
  });

  it('pong', () => {
    expect(decodePongResponse(readBin('pong'))).toEqual(CANON.pong);
    writeBin('pong', encodePongResponse(CANON.pong));
  });

  it('subscribe_request', () => {
    expect(decodeSubscribeRequest(readBin('subscribe_request'))).toEqual(
      CANON.subscribe_request,
    );
    writeBin('subscribe_request', encodeSubscribeRequest(CANON.subscribe_request));
  });

  it('subscribe_response', () => {
    expect(decodeSubscribeResponse(readBin('subscribe_response'))).toEqual(
      CANON.subscribe_response,
    );
    writeBin('subscribe_response', encodeSubscribeResponse(CANON.subscribe_response));
  });

  it('send_request', () => {
    expect(decodeSendMessageRequest(readBin('send_request'))).toEqual(CANON.send_request);
    writeBin('send_request', encodeSendMessageRequest(CANON.send_request));
  });

  it('send_response', () => {
    expect(decodeSendMessageResponse(readBin('send_response'))).toEqual(
      CANON.send_response,
    );
    writeBin('send_response', encodeSendMessageResponse(CANON.send_response));
  });

  it('push_message', () => {
    expect(decodePushMessageRequest(readBin('push_message'))).toEqual(CANON.push_message);
    writeBin('push_message', encodePushMessageRequest(CANON.push_message));
  });

  it('push_batch', () => {
    expect(decodePushBatchRequest(readBin('push_batch'))).toEqual(CANON.push_batch);
    writeBin('push_batch', encodePushBatchRequest(CANON.push_batch));
  });

  it('auth_request', () => {
    expect(decodeAuthorizationRequest(readBin('auth_request'))).toEqual(
      CANON.auth_request,
    );
    writeBin('auth_request', encodeAuthorizationRequest(CANON.auth_request));
  });

  it('auth_response', () => {
    expect(decodeAuthorizationResponse(readBin('auth_response'))).toEqual(
      CANON.auth_response,
    );
    writeBin('auth_response', encodeAuthorizationResponse(CANON.auth_response));
  });

  it.each([
    ['payload_text', CANON.payload_text],
    ['payload_image', CANON.payload_image],
    ['payload_file', CANON.payload_file],
    ['payload_voice', CANON.payload_voice],
    ['payload_video', CANON.payload_video],
    ['payload_location', CANON.payload_location],
    ['payload_contact', CANON.payload_contact],
    ['payload_sticker', CANON.payload_sticker],
    ['payload_forward', CANON.payload_forward],
    ['payload_link', CANON.payload_link],
  ])('%s', (name, expected) => {
    expect(decodeMessagePayloadEnvelope(readBin(name))).toEqual(expected);
    writeBin(name, encodeMessagePayloadEnvelope(expected));
  });

  it.each([
    ['timeline_new_message', CANON.timeline_new_message],
    ['timeline_revoke', CANON.timeline_revoke],
    ['timeline_reaction', CANON.timeline_reaction],
  ])('%s', (name, expected) => {
    expect(decodeCanonicalTimelineEvent(readBin(name))).toEqual(expected);
    writeBin(name, encodeCanonicalTimelineEvent(expected));
  });
});
