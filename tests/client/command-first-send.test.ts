// Command-First: the message and the command that delivers it are written
// together, before anything reaches the wire (MESSAGE_SPEC §8.3).
//
// The online path is the one that used to bypass this — it sent first and
// only wrote an outbox row if the send failed, so a crash between the socket
// write and the ack left a delivered message with no local trace of the send.
// These assertions are ordering assertions: what exists on disk *at the
// moment the transport is called*, not just what exists at the end.

import { afterEach, describe, expect, it } from 'vitest';
import { CacheDB } from '../../src/cache-idb.js';
import {
  PrivchatClient,
  decodeRpcRequest,
  decodeSendMessageRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  encodeSendMessageResponse,
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

describe('command-first send', () => {
  it('has the command on disk before the message reaches the transport', async () => {
    const dbName = `cmd-first-${++dbCounter}`;
    /** What the outbox held at the instant the send hit the wire. */
    let atSendTime: unknown[] = [];

    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      if (pkt.bizType === 5) {
        const decoded = decodeSendMessageRequest(pkt.payload);
        return encodeSendMessageResponse({
          client_seq: decoded.client_seq,
          server_message_id: '700110001',
          message_seq: 100,
          reason_code: 0,
        });
      }
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
    // Read the durable state from a SEPARATE connection, so what is observed
    // is what committed — not what the client happens to hold in memory.
    t.onSendHook = async (pkt) => {
      if (pkt.bizType !== 5) return;
      const observer = new CacheDB(dbName);
      atSendTime = await observer.outbox.toArray();
      observer.close();
    };

    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, db: new CacheDB(dbName) },
    });
    await client.connect();
    await client.authenticate('999', 'tok', 'dev');

    const result = await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'hello',
      local_message_id: '9007199254740801',
    });
    expect(result.status).toBe('sent');

    // 1. The command was durable BEFORE the wire — this is the assertion the
    //    old send path failed.
    expect((atSendTime as Array<{ outbox_id: string }>).map((r) => r.outbox_id)).toEqual([
      '9007199254740801',
    ]);

    // 2. And it is gone afterwards, retired by the same transaction that
    //    applied the ack: a surviving command re-sends a delivered message.
    const after = new CacheDB(dbName);
    expect(await after.outbox.count()).toBe(0);
    const rows = await after.messages_v2.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.server_message_id).toBe('700110001');
    expect(rows[0]!.status).toBe('sent');
    after.close();
  });

  it('links the command to the message row it delivers', async () => {
    // The link is the stable `id`, so the ack knows which row to land on
    // without depending on any key that moves.
    const dbName = `cmd-link-${++dbCounter}`;
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      return undefined;
    };
    client = new PrivchatClient({ transport: t, cache: { enabled: true, db: new CacheDB(dbName) } });
    // Deliberately not authenticated: the offline gate must produce the same
    // durable pair as the online path, since it is the same write.
    const result = await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'queued while offline',
      local_message_id: '9007199254740802',
    });
    expect(result.status).toBe('queued');

    const db = new CacheDB(dbName);
    const rows = await db.messages_v2.toArray();
    const commands = await db.outbox.toArray();
    expect(rows).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.message_id).toBe(rows[0]!.id);
    expect(commands[0]!.status).toBe('pending');
    db.close();
  });

  it('updates the existing command on rejection instead of writing a second one', async () => {
    const dbName = `cmd-reject-${++dbCounter}`;
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      if (pkt.bizType === 5) {
        const decoded = decodeSendMessageRequest(pkt.payload);
        return encodeSendMessageResponse({
          client_seq: decoded.client_seq,
          server_message_id: '0',
          message_seq: 0,
          reason_code: 3,
        });
      }
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
    client = new PrivchatClient({ transport: t, cache: { enabled: true, db: new CacheDB(dbName) } });
    await client.connect();
    await client.authenticate('999', 'tok', 'dev');

    const result = await client.sendTextMessage({
      channel_id: '12345',
      channel_type: 1,
      from_uid: '999',
      content: 'rejected',
      local_message_id: '9007199254740803',
    });
    expect(result.status).toBe('queued');

    const db = new CacheDB(dbName);
    const commands = await db.outbox.toArray();
    // One row, moved to `failed` — not a duplicate beside the one the
    // enqueue already wrote.
    expect(commands).toHaveLength(1);
    expect(commands[0]!.status).toBe('failed');
    expect(commands[0]!.last_error).toContain('rejected: code=3');
    expect(commands[0]!.message_id).toBe((await db.messages_v2.toArray())[0]!.id);
    db.close();
  });
});
