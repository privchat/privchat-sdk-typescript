// u64 precision on JSON paths that bypass the rpcCallTyped lossless
// parser. Snowflake ids are 18 digits (> 2^53); a plain JSON.parse
// silently rounds them, then String(rounded) misses the cache key and
// the update is dropped. These tests pin the lossless behavior of the
// previously-raw parse sites (read-cursor push being the live one).
//
// The id literals MUST be spliced into raw JSON text — JS itself cannot
// represent them as numbers, which is exactly the bug.

import { afterEach, describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  PrivchatClient,
  decodeRpcRequest,
  encodePushMessageRequest,
  encodeRpcResponse,
  MessageType,
  parseRpcJson,
} from '../src/index.js';
import { FakeTransport } from './client/fake-transport.js';

// 18-digit snowflake channel id — far above 2^53.
const BIG_CHANNEL_ID = '581782206540812288';
// Just above 2^53: Number('9007199254740995') rounds to ...96.
const BIG_PTS = '9007199254740995';

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

const rawJsonResponse = (rawJson: string) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(rawJson),
  });

/** sync_entities responder whose channel payload carries the BIG id as a
 *  raw JSON **number literal** (exactly what the server emits). */
function buildFake(): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType !== 17 /* RpcRequest */) return undefined;
    const req = decodeRpcRequest(pkt.payload);
    if (req.route !== 'entity/sync_entities') return undefined;
    const body = JSON.parse(new TextDecoder().decode(req.body)) as {
      entity_type: string;
    };
    if (body.entity_type === 'channel') {
      return rawJsonResponse(
        `{"items":[{"entity_id":"${BIG_CHANNEL_ID}","version":1,"deleted":false,` +
          `"payload":{"channel_id":${BIG_CHANNEL_ID},"channel_type":1,` +
          `"channel_name":"big","unread_count":3}}],` +
          `"next_version":1,"has_more":false}`,
      );
    }
    return rawJsonResponse('{"items":[],"next_version":0,"has_more":false}');
  };
  return t;
}

/** A self_read_pts_updated system push whose metadata carries channel_id
 *  and read_pts as raw JSON number literals (server wire shape). */
function bigReadCursorPush() {
  const payload = new TextEncoder().encode(
    `{"message_type":"notification","content":"cursor",` +
      `"metadata":{"notification_type":"channel_read_cursor_updated",` +
      `"channel_id":${BIG_CHANNEL_ID},"channel_type":1,"reader_id":"999",` +
      `"read_pts":${BIG_PTS},"visibility":"self_read_pts_updated",` +
      `"updated_at":1700000000000}}`,
  );
  return encodePushMessageRequest({
    setting: { need_receipt: false, signal: 0 },
    msg_key: '',
    server_message_id: '1',
    message_seq: 1,
    local_message_id: '0',
    stream_no: '',
    stream_seq: 0,
    stream_flag: 0,
    timestamp: 1_700_000_000,
    channel_id: BIG_CHANNEL_ID,
    channel_type: 1,
    message_type: 5, // ContentMessageType::System
    expire: 0,
    topic: '',
    from_uid: '999',
    payload,
    deleted: false,
  });
}

describe('u64 precision — sanity', () => {
  it('plain JSON.parse rounds the test ids (the bug being defended against)', () => {
    expect(String(JSON.parse(BIG_PTS))).not.toBe(BIG_PTS);
    expect(String(JSON.parse(BIG_CHANNEL_ID))).not.toBe(BIG_CHANNEL_ID);
  });

  it('parseRpcJson preserves them as strings', () => {
    const o = parseRpcJson<{ a: unknown; b: unknown }>(
      `{"a":${BIG_CHANNEL_ID},"b":${BIG_PTS}}`,
    );
    expect(o.a).toBe(BIG_CHANNEL_ID);
    expect(o.b).toBe(BIG_PTS);
  });
});

describe('u64 precision — read-cursor push (previously raw JSON.parse)', () => {
  it('18-digit channel_id cursor push lands on the right channel with exact pts', async () => {
    const t = buildFake();
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `u64-${++dbCounter}` },
    });
    await client.bootstrapChannels();

    // Bootstrap (lossless RPC path) keyed the channel by the EXACT id.
    const seeded = client.cachedChannels()[0]!;
    expect(seeded.channel_id).toBe(BIG_CHANNEL_ID);
    expect(seeded.unread_count).toBe(3);

    // Inbound cursor push — before the fix, JSON.parse rounded
    // metadata.channel_id, String(rounded) missed this cache key, and
    // the update was silently dropped.
    t.fireMessage(
      new Packet({
        packetType: PacketType.OneWay,
        messageId: 0,
        bizType: MessageType.PushMessageRequest,
        payload: bigReadCursorPush(),
      }),
    );
    // Cache write is applied asynchronously off the dispatch loop.
    await new Promise((r) => setTimeout(r, 0));

    const after = client.cachedChannels()[0]!;
    expect(after.read_pts).toBe(BIG_PTS); // exact, not rounded
    expect(after.unread_count).toBe(0); // self-read zeroes unread
  });
});
