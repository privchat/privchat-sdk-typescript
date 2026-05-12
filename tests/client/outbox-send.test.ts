// Phase 5C-1b unit tests for the queued path of `sendTextMessage`.
// Online success + cache-disabled cases live in `local-echo.test.ts`;
// this file is exclusively about the new outbox-backed queued contract.

import { afterEach, describe, expect, it } from 'vitest';
import {
  PrivchatClient,
  decodeRpcRequest,
  decodeSendMessageRequest,
  encodeAuthorizationResponse,
  encodeRpcResponse,
  encodeSendMessageResponse,
  type ConversationPatch,
} from '../../src/index.js';
import { getOutboxByLocalMessageId, listOutboxEntries } from '../../src/cache/index.js';
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

function authResponder(t: FakeTransport): void {
  t.responder = (pkt) => {
    if (pkt.bizType === 1 /* AuthorizationRequest */) {
      return encodeAuthorizationResponse({ success: true });
    }
    if (pkt.bizType === 17 /* RpcRequest */) {
      decodeRpcRequest(pkt.payload);
      return okJson({});
    }
    // SendMessageRequest deliberately not handled here — caller installs
    // a per-test handler before triggering a send.
    return undefined;
  };
}

async function newAuthedClient(transport: FakeTransport, dbName: string): Promise<PrivchatClient> {
  const c = new PrivchatClient({ transport, cache: { enabled: true, dbName } });
  await c.connect();
  await c.authenticate('1', 'tok', 'dev');
  return c;
}

const SAMPLE_INPUT = {
  channel_id: '12345',
  channel_type: 1,
  from_uid: '999',
  content: 'queued-test',
  local_message_id: '9007199254740991',
} as const;

describe('sendTextMessage offline → queued', () => {
  it('returns queued without hitting the wire when client is not authenticated', async () => {
    const t = new FakeTransport();
    // No connect, no authenticate. State stays 'disconnected'.
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `queued-offline-${++dbCounter}` },
    });

    const patches: ConversationPatch[] = [];
    client.observeConversation('12345', 1, (_, p) => patches.push(p));

    const result = await client.sendTextMessage(SAMPLE_INPUT);

    expect(result.status).toBe('queued');
    expect(result.local_message_id).toBe('9007199254740991');
    if (result.status === 'queued') {
      expect(result.outbox_id).toBe('9007199254740991');
    }
    // Sanity: queued branch must not expose a server response.
    expect((result as { response?: unknown }).response).toBeUndefined();

    // Cache row exists, status pending. No ACK swap fired.
    const cached = client.getCachedMessages('12345', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('pending');
    expect(cached[0]!.local_message_id).toBe('9007199254740991');

    // Patches: only the synchronous pending insert.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.upserted[0]!.status).toBe('pending');
    expect(patches[0]!.removed).toEqual([]);
  });

  it('writes an outbox row with status=pending, attempt_count=0, no last_error', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `queued-row-${++dbCounter}` },
    });

    await client.sendTextMessage({ ...SAMPLE_INPUT, local_message_id: '9007199254740992' });

    const entry = await getOutboxByLocalMessageId(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).cacheDb,
      '9007199254740992',
    );
    expect(entry).toBeDefined();
    expect(entry!.outbox_id).toBe('9007199254740992');
    expect(entry!.status).toBe('pending');
    expect(entry!.attempt_count).toBe(0);
    expect(entry!.last_error).toBeUndefined();
    expect(entry!.record_key).toBe('l:9007199254740992');
    expect(entry!.content_type).toBe('text');
    // Payload preserved verbatim (UTF-8 of "queued-test").
    expect(new TextDecoder().decode(entry!.payload)).toBe('queued-test');
  });

  it('does not call the transport (no SendMessageRequest packets sent)', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `no-wire-${++dbCounter}` },
    });

    await client.sendTextMessage({ ...SAMPLE_INPUT, local_message_id: '9007199254740993' });

    const sendPackets = t.sent.filter((p) => p.bizType === 5);
    expect(sendPackets).toHaveLength(0);
  });
});

describe('sendTextMessage online → transport throw → queued', () => {
  it('returns queued, leaves cache pending, writes outbox failed (transient)', async () => {
    const t = new FakeTransport();
    authResponder(t);
    client = await newAuthedClient(t, `transient-${++dbCounter}`);

    // Override the responder so SendMessageRequest never gets a reply →
    // the request times out (transient transport error).
    const baseResponder = t.responder!;
    t.responder = (pkt) => {
      if (pkt.bizType === 5 /* SendMessageRequest */) return undefined; // black-hole
      return baseResponder(pkt);
    };
    // Need a tighter timeout for the test to finish quickly. Construct
    // a fresh client with the right defaults — we can't tweak in place.
    await client.disconnect();
    client = new PrivchatClient({
      transport: t,
      defaultTimeoutMs: 60,
      cache: { enabled: true, dbName: `transient-2-${dbCounter}` },
    });
    await client.connect();
    await client.authenticate('1', 'tok', 'dev');

    const patches: ConversationPatch[] = [];
    client.observeConversation('12345', 1, (_, p) => patches.push(p));

    const result = await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740994',
    });

    expect(result.status).toBe('queued');
    if (result.status === 'queued') {
      expect(result.outbox_id).toBe('9007199254740994');
    }

    // Cache row still pending (NOT regressed to failed).
    const cached = client.getCachedMessages('12345', 1);
    expect(cached).toHaveLength(1);
    expect(cached[0]!.status).toBe('pending');

    // Patches: only the synchronous pending insert.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.upserted[0]!.status).toBe('pending');

    // Outbox row written with status='failed', attempt_count=1, last_error
    // prefixed 'transient:'. The 5C-1c flush engine reads that prefix to
    // decide retry eligibility.
    const entry = await getOutboxByLocalMessageId(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).cacheDb,
      '9007199254740994',
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('failed');
    expect(entry!.attempt_count).toBe(1);
    expect(entry!.last_error).toMatch(/^transient:/);
  });
});

describe('sendTextMessage online → reason_code !== 0 → queued (rejected)', () => {
  it('returns queued, leaves cache pending, writes outbox failed (rejected)', async () => {
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
      return undefined;
    };
    client = await newAuthedClient(t, `rejected-${++dbCounter}`);

    const patches: ConversationPatch[] = [];
    client.observeConversation('12345', 1, (_, p) => patches.push(p));

    const result = await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740995',
    });

    expect(result.status).toBe('queued');
    if (result.status === 'queued') {
      expect(result.outbox_id).toBe('9007199254740995');
    }

    // Cache stays pending — UI signal for rejection comes from the
    // outbox observer (5C-1e), not from MessageRecord.status.
    expect(client.getCachedMessages('12345', 1)[0]!.status).toBe('pending');

    // Outbox: failed (rejected) — engine MUST NOT auto-retry.
    const entry = await getOutboxByLocalMessageId(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).cacheDb,
      '9007199254740995',
    );
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('failed');
    expect(entry!.attempt_count).toBe(1);
    expect(entry!.last_error).toMatch(/^rejected: code=503/);

    // Only the pending insert patch fired; no failed transition emitted
    // (the cache row didn't change state).
    expect(patches).toHaveLength(1);
  });
});

describe('online success path leaves outbox empty', () => {
  it('writes no outbox row when send ACKs inline', async () => {
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
      return undefined;
    };
    client = await newAuthedClient(t, `clean-${++dbCounter}`);

    const result = await client.sendTextMessage({
      ...SAMPLE_INPUT,
      local_message_id: '9007199254740996',
    });
    expect(result.status).toBe('sent');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await listOutboxEntries((client as any).cacheDb);
    expect(all).toEqual([]);
  });
});
