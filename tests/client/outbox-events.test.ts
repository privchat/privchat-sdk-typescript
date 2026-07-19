// Phase 5C-1e tests: outboxEntries / observeOutbox / discardOutboxEntry
// + L1 events `outbox_state_changed` and `outbox_drained`. Built on the
// existing FakeTransport-based authed client pattern; outbox-engine
// behaviour itself is exercised in `tests/outbox-engine.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import {
  CacheDisabledError,
  PrivchatClient,
  decodeRpcRequest,
  decodeSendMessageRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  encodeSendMessageResponse,
  type OutboxEntry,
  type OutboxStateChangedEvent,
  type SdkEvent,
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

interface SendBehavior {
  /** Wire response to return for SendMessageRequest. If omitted the
   *  send is black-holed (transport timeout). */
  build?: (decoded: ReturnType<typeof decodeSendMessageRequest>) => Uint8Array;
}

function newAuthedClient(
  send: SendBehavior = {},
  options: { offline?: boolean } = {},
): { t: FakeTransport; client: PrivchatClient } {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
    if (pkt.bizType === 5) {
      const decoded = decodeSendMessageRequest(pkt.payload);
      if (send.build) return send.build(decoded);
      return undefined; // black-hole
    }
    if (pkt.bizType === 17) {
      decodeRpcRequest(pkt.payload);
      return okJson({});
    }
    return undefined;
  };
  const c = new PrivchatClient({
    transport: t,
    cache: { enabled: true, dbName: `outbox-events-${++dbCounter}` },
    defaultTimeoutMs: options.offline ? 30 : 30_000,
  });
  client = c;
  return { t, client: c };
}

async function authenticate(c: PrivchatClient): Promise<void> {
  await c.connect();
  await c.authenticate('1', 'tok', 'dev');
}

/** Settle async snapshot pushes / IDB writes. */
async function flushTicks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SAMPLE_INPUT = {
  channel_id: '12345',
  channel_type: 1,
  from_uid: '999',
  content: 'hello',
} as const;

describe('outboxEntries', () => {
  it('returns the persisted rows', async () => {
    const { client } = newAuthedClient();
    // No connect → offline → enqueue.
    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740001',
    });
    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740002',
    });
    const rows = await client.outboxEntries();
    expect(rows.map((r) => r.outbox_id).sort()).toEqual([
      '9007199254740001',
      '9007199254740002',
    ]);
  });

  it('respects status / channel filters', async () => {
    const { client } = newAuthedClient();
    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      channel_id: '100',
      local_message_id: '9007199254740011',
    });
    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      channel_id: '200',
      local_message_id: '9007199254740012',
    });
    const onlyCh100 = await client.outboxEntries({ channel_id: '100', channel_type: 1 });
    expect(onlyCh100.map((r) => r.channel_id)).toEqual(['100']);
  });

  it('throws CacheDisabledError when cache is off', async () => {
    const t = new FakeTransport();
    const c = new PrivchatClient({ transport: t });
    await expect(c.outboxEntries()).rejects.toThrow(CacheDisabledError);
  });
});

describe('observeOutbox', () => {
  it('fires an initial snapshot on subscribe', async () => {
    const { client } = newAuthedClient();
    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740101',
    });

    const snapshots: OutboxEntry[][] = [];
    const off = client.observeOutbox((entries) => snapshots.push(entries));
    await flushTicks();

    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    // Latest snapshot must contain the enqueued row.
    const latest = snapshots[snapshots.length - 1]!;
    expect(latest.map((r) => r.outbox_id)).toEqual(['9007199254740101']);
    off();
  });

  it('fires a new snapshot on enqueue', async () => {
    const { client } = newAuthedClient();
    const snapshots: OutboxEntry[][] = [];
    const off = client.observeOutbox((entries) => snapshots.push(entries));
    await flushTicks();
    const baseline = snapshots.length;

    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740111',
    });
    await flushTicks();

    expect(snapshots.length).toBeGreaterThan(baseline);
    expect(snapshots[snapshots.length - 1]!.map((r) => r.outbox_id)).toEqual([
      '9007199254740111',
    ]);
    off();
  });

  it('unsubscribe stops further snapshots', async () => {
    const { client } = newAuthedClient();
    const snapshots: OutboxEntry[][] = [];
    const off = client.observeOutbox((entries) => snapshots.push(entries));
    await flushTicks();
    off();
    const after = snapshots.length;

    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740121',
    });
    await flushTicks();
    expect(snapshots.length).toBe(after);
  });

  it('returns a noop unsubscribe when cache is disabled', async () => {
    const t = new FakeTransport();
    const c = new PrivchatClient({ transport: t });
    const snapshots: OutboxEntry[][] = [];
    const off = c.observeOutbox((entries) => snapshots.push(entries));
    await flushTicks();
    expect(snapshots).toEqual([]);
    expect(typeof off).toBe('function');
    off();
  });
});

describe('outbox_state_changed event', () => {
  it('fires `pending` on enqueue', async () => {
    const { client } = newAuthedClient();
    const events: OutboxStateChangedEvent[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'outbox_state_changed') events.push(env.event);
    });

    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740201',
    });
    await flushTicks();

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('pending');
    expect(events[0]!.outbox_id).toBe('9007199254740201');
    expect(events[0]!.local_message_id).toBe('9007199254740201');
  });

  it('fires `sending` then `sent` on a successful flush', async () => {
    // Claim the fresh DB for this account once, then go offline and enqueue.
    // Unowned pre-auth rows are intentionally discarded by the account
    // isolation guard because they cannot be attributed safely.
    // Sequence: pending (enqueue) → sending → sent.
    const { client } = newAuthedClient({
      build: (decoded) =>
        encodeSendMessageResponse({
          client_seq: decoded.client_seq,
          server_message_id: '777',
          message_seq: 99,
          reason_code: 0,
        }),
    });
    const events: OutboxStateChangedEvent[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'outbox_state_changed') events.push(env.event);
    });

    await authenticate(client);
    await client.disconnect();

    const queued = await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740301',
    });
    expect(queued.status).toBe('queued');

    await authenticate(client);
    const result = await client.flushOutbox();
    expect(result.sent).toBe(1);

    expect(events.map((e) => e.status)).toEqual(['pending', 'sending', 'sent']);
    expect(events[2]!.server_message_id).toBe('777');
  });

  it('fires `failed` on rejected (reason_code !== 0) flush', async () => {
    // Construct: enqueue offline, then authenticate, then flush with a
    // server that returns reason_code=503.
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      if (pkt.bizType === 5) {
        const decoded = decodeSendMessageRequest(pkt.payload);
        return encodeSendMessageResponse({
          client_seq: decoded.client_seq,
          server_message_id: '0',
          message_seq: 0,
          reason_code: 503,
        });
      }
      if (pkt.bizType === 17) return okJson({});
      return undefined;
    };
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `outbox-events-rej-${++dbCounter}` },
    });
    const events: OutboxStateChangedEvent[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'outbox_state_changed') events.push(env.event);
    });

    await client.connect();
    await client.authenticate('1', 'tok', 'dev');
    await client.disconnect();

    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740401',
    });
    await client.connect();
    await client.authenticate('1', 'tok', 'dev');
    const result = await client.flushOutbox();
    expect(result.failed).toBe(1);

    // pending → sending → failed
    expect(events.map((e) => e.status)).toEqual(['pending', 'sending', 'failed']);
    expect(events[2]!.last_error).toMatch(/^rejected: code=503/);
  });
});

describe('outbox_drained event', () => {
  it('fires when the queue transitions non-empty → empty', async () => {
    const t = new FakeTransport();
    t.responder = (pkt) => {
      if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
      if (pkt.bizType === 5) {
        const decoded = decodeSendMessageRequest(pkt.payload);
        return encodeSendMessageResponse({
          client_seq: decoded.client_seq,
          server_message_id: '700',
          message_seq: 1,
          reason_code: 0,
        });
      }
      if (pkt.bizType === 17) return okJson({});
      return undefined;
    };
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `outbox-events-drained-${++dbCounter}` },
    });
    const events: SdkEvent[] = [];
    client.observeEvents((env) => events.push(env.event));

    // Bind ownership, then enqueue while offline.
    await client.connect();
    await client.authenticate('1', 'tok', 'dev');
    await client.disconnect();
    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740501',
    });
    await flushTicks();
    expect(events.some((e) => e.type === 'outbox_drained')).toBe(false);

    // Authenticate + flush → ACK → row deleted → drained.
    await client.connect();
    await client.authenticate('1', 'tok', 'dev');
    await client.flushOutbox();
    await flushTicks();

    expect(events.filter((e) => e.type === 'outbox_drained')).toHaveLength(1);
  });

  it('does NOT fire on initial empty observer subscription', async () => {
    const { client } = newAuthedClient();
    const events: SdkEvent[] = [];
    client.observeEvents((env) => events.push(env.event));
    const off = client.observeOutbox(() => {});
    await flushTicks();
    expect(events.filter((e) => e.type === 'outbox_drained')).toHaveLength(0);
    off();
  });
});

describe('discardOutboxEntry', () => {
  it('removes the outbox row and emits `discarded`', async () => {
    const { client } = newAuthedClient();
    const events: OutboxStateChangedEvent[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'outbox_state_changed') events.push(env.event);
    });

    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740601',
    });
    expect(await client.outboxEntries()).toHaveLength(1);

    await client.discardOutboxEntry('9007199254740601');
    expect(await client.outboxEntries()).toHaveLength(0);
    // Cache MessageRecord is gone too.
    expect(client.getCachedMessages('12345', 1)).toEqual([]);

    expect(events.map((e) => e.status)).toEqual(['pending', 'discarded']);
    expect(events[1]!.outbox_id).toBe('9007199254740601');
  });

  it('emits `outbox_drained` when discard empties the queue', async () => {
    const { client } = newAuthedClient();
    const events: SdkEvent[] = [];
    client.observeEvents((env) => events.push(env.event));

    await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740611',
    });
    await flushTicks();
    await client.discardOutboxEntry('9007199254740611');
    await flushTicks();

    expect(events.filter((e) => e.type === 'outbox_drained')).toHaveLength(1);
  });

  it('throws when the outbox_id is unknown', async () => {
    const { client } = newAuthedClient();
    await expect(client.discardOutboxEntry('does-not-exist')).rejects.toThrow(
      /outbox row not found/,
    );
  });

  it('throws CacheDisabledError when cache is off', async () => {
    const t = new FakeTransport();
    const c = new PrivchatClient({ transport: t });
    await expect(c.discardOutboxEntry('any')).rejects.toThrow(CacheDisabledError);
  });
});
