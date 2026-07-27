// The `message_rehydrate` repair, end to end.
//
// The situation it exists for: the server accepted a media message, the local
// ACK commit did not land, and the cache row is gone.
//
// The design premise — NOT something this test seeds — is that the sync cursor
// has already moved past the message, so `sync/get_difference` would never
// return it again and recovery has to fetch it by its server id instead. That
// premise is why the fix is anchored rather than cursor-relative, and the
// assertions below pin the anchoring itself: recovery must go to
// `message/history/around`, and the row must come back. Falling back to
// `syncChannel` fails both, so a fake cursor-filtering sync would add setup
// without adding a single thing the test can catch.
//
// Every id here is above 2^53 on purpose. `Number()` silently changes those,
// and a test using small ids cannot see it.

import { afterEach, describe, expect, it } from 'vitest';
import {
  PrivchatClient,
  decodeRpcRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
} from '../../src/index.js';
import { getOutboxEntry, putOutboxEntry } from '../../src/cache/index.js';
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

/** Past 2^53: `Number('9007199254740993')` is 9007199254740992. */
const CHANNEL_ID = '9007199254740993';
const SERVER_MESSAGE_ID = '9007199254740995';
const STABLE_ID = 'stable-id-kept-across-repair';

const okJson = (data: unknown) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(JSON.stringify(data)),
  });

describe('message_rehydrate repair', () => {
  it('recovers a delivered message the cursor has passed, without re-sending it', async () => {
    const t = new FakeTransport();
    const rpcRoutes: string[] = [];
    let aroundChannelId: unknown;
    let sendCalls = 0;

    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      if (pkt.bizType === 2) {
        // A SendMessageRequest reaching the wire at all would mean recovery
        // re-sent an already-delivered message.
        sendCalls += 1;
        return undefined;
      }
      if (pkt.bizType === 17) {
        const req = decodeRpcRequest(pkt.payload);
        rpcRoutes.push(req.route);
        if (req.route === 'message/history/around') {
          // The wire keeps u64 ids as unquoted literals, which JSON.parse
          // would immediately round off — read the field out of the raw text.
          const raw = new TextDecoder().decode(req.body);
          aroundChannelId = /"?channel_id"?\s*:\s*"?(\d+)"?/.exec(raw)?.[1];
          return okJson({
            anchor_message: {
              message_id: SERVER_MESSAGE_ID,
              message_seq: 4242,
              channel_id: CHANNEL_ID,
              from_uid: '1',
              message_type: 2,
              content: '',
              timestamp: 1_700_000_000_000,
            },
            before_messages: [],
            after_messages: [],
            has_more_before: false,
            has_more_after: false,
          });
        }
        return okJson({});
      }
      return undefined;
    };

    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `rehydrate-${++dbCounter}` },
    });
    await client.connect();
    await client.authenticate('1', 'tok', 'dev');

    const db = (client as unknown as { cacheDb: Parameters<typeof putOutboxEntry>[0] }).cacheDb;

    // The exact damaged state: an image command the server already ACKed,
    // whose cache row is absent. No message row is seeded — that is the point.
    await putOutboxEntry(db, {
      outbox_id: 'cmd-rehydrate',
      message_id: STABLE_ID,
      channel_id: CHANNEL_ID,
      channel_type: 1,
      local_message_id: 'cmd-rehydrate',
      from_uid: '1',
      content_type: 'image',
      payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      payload_encoding: 'message_envelope',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      attempt_count: 0,
      next_attempt_at: 0,
      status: 'ack_pending',
      acked_server_message_id: SERVER_MESSAGE_ID,
      acked_message_seq: 4242,
    });

    // Two passes: the first raises the fault and runs the host repair, the
    // second replays the stored ACK against the rehydrated row.
    await client.flushOutbox();
    await client.flushOutbox();

    // 1. Recovery went to the anchored route, not a channel resync — this is
    //    what stands in for the cursor premise above.
    expect(rpcRoutes).toContain('message/history/around');
    // 2. …and carried the channel id intact. `Number()` would have made this
    //    9007199254740992.
    expect(String(aroundChannelId)).toBe(CHANNEL_ID);
    // 3. The message was never re-sent: it was already delivered, and the
    //    server's idempotency record does not live forever.
    expect(sendCalls).toBe(0);
    // 4. The command is done, not quarantined.
    expect(await getOutboxEntry(db, 'cmd-rehydrate')).toBeUndefined();
    // 5. The row is back, under the id everything else still points at —
    //    not the fresh one history minted for it.
    const rows = await db.messages_v2.toArray();
    const recovered = rows.find((m) => m.server_message_id === SERVER_MESSAGE_ID);
    expect(recovered).toBeDefined();
    expect(recovered?.id).toBe(STABLE_ID);
    expect(recovered?.status).toBe('sent');
  });
});
