// The four official media builders, driven into the durable outbox.
//
// Scope, stated exactly: builder → sendTextMessage → validation → outbox
// persistence. These deliberately stay unauthenticated, so nothing reaches
// the wire; what is under test is that a builder's output is accepted at all.
//
// Asserting on what a builder returns cannot catch a builder that produces an
// input `sendTextMessage` refuses. That is exactly what happened: making
// `payload_encoding` required left all four supplying bytes without one, so
// every image, file, voice and video send threw at runtime while the returned
// objects still looked correct — and `tsc` said nothing, because an optional
// field is satisfied by omitting it.

import { afterEach, describe, expect, it } from 'vitest';
import { CacheDB } from '../../src/cache-idb.js';
import {
  PrivchatClient,
  buildSendFileInput,
  buildSendImageInput,
  buildSendVideoInput,
  buildSendVoiceInput,
  decodeRpcRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  type SendTextInput,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

let client: PrivchatClient | null = null;
let dbCounter = 0;

afterEach(async () => {
  if (client) {
    try {
      await client.disconnect();
    } catch {
      /* */
    }
    client = null;
  }
});

const CHANNEL = { channel_id: '12345', channel_type: 1, from_uid: '999' } as const;

const builders: Array<[string, (lid: string) => SendTextInput]> = [
  [
    'image',
    (lid) =>
      buildSendImageInput({
        ...CHANNEL,
        metadata: {
          file_id: '900',
          width: 96,
          height: 64,
          thumbnail_file_id: '901',
        },
        local_message_id: lid,
      }),
  ],
  [
    'file',
    (lid) =>
      buildSendFileInput({
        ...CHANNEL,
        metadata: { file_id: '902', filename: 'a.pdf', mime_type: 'application/pdf', size: 12 },
        local_message_id: lid,
      }),
  ],
  [
    'voice',
    (lid) =>
      buildSendVoiceInput({
        ...CHANNEL,
        metadata: { file_id: '903', duration: 3 },
        local_message_id: lid,
      }),
  ],
  [
    'video',
    (lid) =>
      buildSendVideoInput({
        ...CHANNEL,
        metadata: {
          file_id: '904',
          width: 320,
          height: 240,
          duration: 5,
          thumbnail_file_id: '905',
        },
        local_message_id: lid,
      }),
  ],
];

describe.each(builders)('buildSend%sInput reaches the durable outbox', (kind, build) => {
  it(`enqueues a ${kind} message without throwing`, async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      if (pkt.bizType === 17) {
        decodeRpcRequest(pkt.payload);
        return encodeRpcResponse({
          code: 0,
          message: 'ok',
          data: new TextEncoder().encode('{}'),
        });
      }
      return undefined;
    };

    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, db: new CacheDB(`media-builder-${kind}-${++dbCounter}`) },
    });
    const input = build(`lid-${kind}`);
    const result = await client.sendTextMessage(input);

    expect(result.status).toBe('queued');
    // And the encoding travelled with the bytes, so a cold-start rebuild can
    // read them back rather than guessing.
    const db = (client as unknown as { cacheDb: { outbox: { get(k: string): Promise<unknown> } } })
      .cacheDb;
    const row = (await db.outbox.get(`lid-${kind}`)) as
      | { payload_encoding?: string }
      | undefined;
    expect(row?.payload_encoding).toBe('message_envelope');
  });
});
