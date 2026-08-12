// `sendTextMessage` is durable-or-nothing at both ends
// (CONVERSATION_DEPENDENCY_READINESS §3.3).
//
// Two windows exist where the database can refuse the write:
//
//   1. before the send — the pending row. Sending anyway would leave the
//      server holding a message with no local row, so the ACK has no
//      identity to inherit and a reload mints a new one.
//   2. after the ACK — the rekey. Publishing `sent` there would also bump
//      `latest_pts` past this commit via `refreshChannelOnSend`, and the
//      sync that was supposed to reconcile it would never fetch it again.
//
// Failures are injected at the cache-module boundary; `vi.mock` is
// module-scoped, hence the dedicated file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fail = { pendingWrite: false, ackRekey: false };

vi.mock('../../src/cache/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/cache/index.js')>(
    '../../src/cache/index.js',
  );
  return {
    ...actual,
    // The two atomic entry points the send path actually uses. Injecting on
    // `upsertMessage`/`applyAck` instead would prove nothing: the send path
    // writes the message and its command together, and applies the ack and
    // retires the command together, so those are the transactions that can
    // fail as a unit.
    createLocalMessageQueued: async (
      ...args: Parameters<typeof actual.createLocalMessageQueued>
    ) => {
      if (fail.pendingWrite) throw new Error('injected: pending write failed');
      return actual.createLocalMessageQueued(...args);
    },
    commitAck: async (...args: Parameters<typeof actual.commitAck>) => {
      if (fail.ackRekey) throw new Error('injected: ack commit failed');
      return actual.commitAck(...args);
    },
  };
});

const {
  PrivchatClient,
  LocalMessagePersistError,
  AckPersistenceError,
  encodeAuthorizationResponse,
  encodeSendMessageResponse,
  decodeSendMessageRequest,
  decodeRpcRequest,
  encodeRpcResponse,
} = await import('../../src/index.js');
const { CacheDB } = await import('../../src/cache-idb.js');
const { ensureCacheOwner, upsertChannels } = await import(
  '../../src/cache/index.js'
);
const { FakeTransport } = await import('./fake-transport.js');

let client: InstanceType<typeof PrivchatClient> | null = null;
let dbCounter = 0;
let dbName = '';
const sendCalls: string[] = [];

function transport(): InstanceType<typeof FakeTransport> {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
    if (pkt.bizType === 5) {
      const decoded = decodeSendMessageRequest(pkt.payload);
      sendCalls.push(decoded.local_message_id);
      return encodeSendMessageResponse({
        client_seq: decoded.client_seq,
        server_message_id: '700110001',
        message_seq: 100,
        reason_code: 0,
      });
    }
    if (pkt.bizType === 17) {
      decodeRpcRequest(pkt.payload);
      // Entity-sync bootstrap: no server-side entities in this test, the
      // channel comes from the durable cache.
      return encodeRpcResponse({
        code: 0,
        message: 'ok',
        data: new TextEncoder().encode(
          JSON.stringify({ items: [], has_more: false, next_version: 0 }),
        ),
      });
    }
    return undefined;
  };
  return t;
}

const send = () =>
  client!.sendTextMessage({
    channel_id: '12345',
    channel_type: 1,
    from_uid: '999',
    content: 'hello',
    local_message_id: '9007199254740994',
  });

beforeEach(async () => {
  fail.pendingWrite = false;
  fail.ackRekey = false;
  sendCalls.length = 0;
  dbName = `send-fail-${++dbCounter}`;

  // Seed a channel so `refreshChannelOnSend` has a cursor it *could*
  // advance — without one it early-returns and the assertion below would
  // prove nothing.
  const seed = new CacheDB(dbName);
  await ensureCacheOwner(seed, '999');
  await upsertChannels(seed, [
    {
      channel_id: '12345',
      channel_type: 1,
      title: 'peer',
      latest_pts: '5',
      read_pts: '5',
      unread_count: 0,
      last_message_preview: '',
      updated_at: 1_700_000_000_000,
      sync_version: 1,
    },
  ]);
  seed.close();

  client = new PrivchatClient({
    transport: transport(),
    cache: { enabled: true, db: new CacheDB(dbName) },
  });
  await client.connect();
  await client.authenticate('999', 'tok', 'dev');
  // Hydrates the memory store from the durable cache (the RPC leg returns
  // nothing here), which is what puts the seeded channel in front of
  // `refreshChannelOnSend`.
  await client.bootstrapChannels();
});

afterEach(async () => {
  fail.pendingWrite = false;
  fail.ackRekey = false;
  if (client) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    client = null;
  }
});

describe('sendTextMessage — pending row cannot be persisted', () => {
  it('rejects with a not-sent error the caller may safely retry', async () => {
    fail.pendingWrite = true;
    const err = await send().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LocalMessagePersistError);
    // The whole point of the split: a retry button on this state cannot
    // duplicate anything, because nothing was delivered.
    expect((err as InstanceType<typeof LocalMessagePersistError>).remoteAccepted).toBe(false);
  });

  it('rolls the local echo back instead of leaving a ghost "sending" row', async () => {
    fail.pendingWrite = true;
    await send().catch(() => undefined);

    // Nothing owns such a row — not the outbox, not the wire, not a sync.
    // Left in place it would say "sending" forever.
    expect(client!.getCachedMessages('12345', 1)).toEqual([]);

    // And the command did not survive on its own either: the pair is one
    // transaction, so a failure leaves neither half behind.
    const reopened = new CacheDB(dbName);
    expect(await reopened.messages_v2.count()).toBe(0);
    expect(await reopened.outbox.count()).toBe(0);
    reopened.close();
  });

  it('never puts the message on the wire', async () => {
    fail.pendingWrite = true;
    await send().catch(() => undefined);
    expect(sendCalls).toEqual([]);
  });
});

describe('sendTextMessage — ACK cannot be persisted', () => {
  it('rejects with a delivered-but-unrecorded error, not a plain send failure', async () => {
    fail.ackRekey = true;
    const err = await send().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AckPersistenceError);
    const ack = err as InstanceType<typeof AckPersistenceError>;
    // Re-sending on this state would deliver the message twice, so the
    // error has to carry that fact and the server's identity for it.
    expect(ack.remoteAccepted).toBe(true);
    expect(ack.local_message_id).toBe('9007199254740994');
    expect(ack.server_message_id).toBe('700110001');
    expect(ack.message_seq).toBe(100);
    // The send itself did happen — this is specifically the local half
    // failing after the server accepted the message.
    expect(sendCalls).toEqual(['9007199254740994']);
  });

  it('leaves the row pending in memory, not published as sent', async () => {
    fail.ackRekey = true;
    await send().catch(() => undefined);

    const cached = client!.getCachedMessages('12345', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('pending');
    expect(cached[0]!.server_message_id).toBeUndefined();
  });

  it('does not advance the channel cursor past the unreconciled commit', async () => {
    fail.ackRekey = true;
    const before = client!.cachedChannels().find((c) => c.channel_id === '12345');
    expect(before?.latest_pts).toBe('5');

    await send().catch(() => undefined);

    const after = client!.cachedChannels().find((c) => c.channel_id === '12345');
    // 100 is the message_seq the ACK carried. Taking it here would make the
    // recovery sync start after this commit and never fetch it again.
    expect(after?.latest_pts).toBe('5');
  });

  it('keeps the pending row on disk so a reload can still reconcile it', async () => {
    fail.ackRekey = true;
    await send().catch(() => undefined);

    const reopened = new CacheDB(dbName);
    const rows = await reopened.messages_v2.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.local_message_id).toBe('9007199254740994');
    expect(rows[0]!.status).toBe('pending');
    // The command is still there too — an ack that did not commit must not
    // retire the command that would otherwise recover it.
    expect(await reopened.outbox.count()).toBe(1);
    reopened.close();
  });
});
