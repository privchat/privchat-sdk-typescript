import { afterEach, describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  MessageType,
  PrivchatClient,
  decodeRpcRequest,
  encodeAuthorizationResponse,
  encodePushBatchRequest,
  encodePushMessageRequest,
  encodeRpcResponse,
  type ConversationPatch,
  type PushMessageRequest,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

let client: PrivchatClient | null = null;
let dbCounter = 0;
afterEach(async () => {
  if (client) {
    try { await client.disconnect(); } catch { /* */ }
    client = null;
  }
});

const okJson = (data: unknown) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(JSON.stringify(data)),
  });

const samplePush = (overrides: Partial<PushMessageRequest> = {}): PushMessageRequest => ({
  setting: { need_receipt: false, signal: 0 },
  msg_key: 'k',
  server_message_id: '700110001',
  message_seq: 100,
  local_message_id: '0',
  stream_no: '',
  stream_seq: 0,
  stream_flag: 0,
  timestamp: 1_700_000,
  channel_id: '12345',
  channel_type: 1,
  message_type: 0,
  expire: 0,
  topic: '',
  from_uid: '999',
  payload: new Uint8Array(),
  deleted: false,
  ...overrides,
});

const fireOneWay = (t: FakeTransport, bizType: number, payload: Uint8Array) => {
  t.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0, bizType, payload }));
};

describe('inbound push → cache absorption', () => {
  it('with cache enabled, push lands in memory + IndexedDB and emits a patch', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `push-${++dbCounter}` },
    });

    const patches: ConversationPatch[] = [];
    client.observeConversation('12345', 1, (_, p) => patches.push(p));

    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePush()));

    // Sync emit
    expect(patches).toHaveLength(1);
    expect(patches[0]!.upserted[0]!.server_message_id).toBe('700110001');
    expect(patches[0]!.is_remote).toBe(true);
    // In-memory cache populated
    expect(client.getCachedMessages('12345', 1)).toHaveLength(1);
  });

  it('with cache disabled, push is silently ignored by cache (still emits L1 event)', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({ transport: t });
    let pushCount = 0;
    client.onPushMessage(() => pushCount++);
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(samplePush()));
    expect(pushCount).toBe(1);
    expect(client.isCacheEnabled()).toBe(false);
  });

  it('PushBatch absorbs every message into the cache', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `batch-${++dbCounter}` },
    });
    const seen: Array<string | undefined> = [];
    client.observeConversation('12345', 1, (_, p) => {
      for (const m of p.upserted) seen.push(m.server_message_id);
    });

    const batch = {
      messages: [
        samplePush({ server_message_id: '1', message_seq: 1 }),
        samplePush({ server_message_id: '2', message_seq: 2 }),
        samplePush({ server_message_id: '3', message_seq: 3 }),
      ],
    };
    fireOneWay(t, MessageType.PushBatchRequest, encodePushBatchRequest(batch));

    expect(seen).toEqual(['1', '2', '3']);
    expect(client.getCachedMessages('12345', 1)).toHaveLength(3);
  });

  it('promotes channel.latest_pts + bumps unread_count when push exceeds read_pts', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '12345',
          version: 1,
          payload: { channel_id: 12345, channel_type: 1, channel_name: 'A', unread_count: 0 },
        },
      ],
      cursorItems: [],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `promote-${++dbCounter}` },
    });
    // Authenticate as alice (not the sender) so unread bumps
    await client.connect();
    setupAuthOk(t);
    await client.authenticate('1001', 'tok', 'dev-1');
    await client.bootstrapChannels();
    const before = client.cachedChannels()[0]!;
    expect(before.latest_pts).toBe('0');
    expect(before.unread_count).toBe(0);

    // Receive push from someone else (uid 999, not 1001)
    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(samplePush({ message_seq: 50, from_uid: '999' })),
    );

    const after = client.cachedChannels()[0]!;
    expect(after.latest_pts).toBe('50');
    expect(after.unread_count).toBe(1);
  });

  it('does NOT bump unread_count when push is from the current user', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '12345',
          version: 1,
          payload: { channel_id: 12345, channel_type: 1, channel_name: 'A', unread_count: 0 },
        },
      ],
      cursorItems: [],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `self-${++dbCounter}` },
    });
    await client.connect();
    setupAuthOk(t);
    await client.authenticate('999', 'tok', 'dev-1');
    await client.bootstrapChannels();

    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(samplePush({ message_seq: 50, from_uid: '999' })),
    );

    const ch = client.cachedChannels()[0]!;
    expect(ch.latest_pts).toBe('50');
    expect(ch.unread_count).toBe(0); // self-message doesn't bump unread
  });
});

// ----- helpers (mirror bootstrap-channels.test.ts) -----

function entitySyncFake(opts: {
  channelItems: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
  cursorItems: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
}): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    const req = decodeRpcRequest(pkt.payload);
    if (req.route === 'entity/sync_entities') {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as { entity_type: string };
      if (body.entity_type === 'channel') {
        return okJson({
          items: opts.channelItems.map((i) => ({ deleted: false, ...i })),
          next_version: opts.channelItems.length,
          has_more: false,
        });
      }
      if (body.entity_type === 'channel_read_cursor') {
        return okJson({
          items: opts.cursorItems.map((i) => ({ deleted: false, ...i })),
          next_version: opts.cursorItems.length,
          has_more: false,
        });
      }
    }
    return okJson({ items: [], next_version: 0, has_more: false });
  };
  return t;
}

/** Replace the responder so the next AuthorizationRequest gets ok. Preserves existing entity-sync behaviour. */
function setupAuthOk(t: FakeTransport): void {
  const prev = t.responder;
  t.responder = (pkt) => {
    if (pkt.bizType === MessageType.AuthorizationRequest) {
      return encodeAuthorizationResponse({ success: true });
    }
    return prev?.(pkt);
  };
}
