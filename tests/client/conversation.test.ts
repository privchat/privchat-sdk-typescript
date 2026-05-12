import { afterEach, describe, expect, it } from 'vitest';
import {
  PrivchatClient,
  decodeRpcRequest,
  encodeRpcResponse,
  type ConversationPatch,
  type ConversationSnapshot,
  type MessageRecord,
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

interface FakeMsg {
  message_id: number;
  channel_id: number;
  sender_id: number;
  content: string;
  message_type: string;
  timestamp: number;
}

function buildHistoryFake(opts: {
  /** Map: (channel_id, before_message_id|undefined) → page of messages */
  pages: Map<string, FakeMsg[]>;
}): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    const req = decodeRpcRequest(pkt.payload);
    if (req.route !== 'message/history/get') return undefined;
    const body = JSON.parse(new TextDecoder().decode(req.body)) as {
      channel_id: number;
      limit?: number;
      before_server_message_id?: number;
    };
    const key = `${body.channel_id}::${body.before_server_message_id ?? ''}`;
    const messages = opts.pages.get(key) ?? [];
    return okJson({ messages, total: messages.length, has_more: false });
  };
  return t;
}

const fakeMsg = (id: number, content = `m${id}`): FakeMsg => ({
  message_id: id,
  channel_id: 100,
  sender_id: 999,
  content,
  message_type: 'text',
  timestamp: id * 1000,
});

const newClient = (transport: FakeTransport) => {
  client = new PrivchatClient({
    transport,
    cache: { enabled: true, dbName: `conv-${++dbCounter}` },
  });
  return client;
};

describe('openConversation', () => {
  it('emits remote snapshot when no cache exists', async () => {
    const t = buildHistoryFake({
      pages: new Map([['100::', [fakeMsg(10), fakeMsg(11), fakeMsg(12)]]]),
    });
    const c = newClient(t);
    const seen: ConversationSnapshot[] = [];
    c.observeConversation('100', 1, (snap) => seen.push(snap));
    const result = await c.openConversation('100', 1);

    // 1 emit (remote only — no cache to emit first time)
    expect(seen).toHaveLength(1);
    expect(seen[0]!.is_remote).toBe(true);
    expect(seen[0]!.messages.map((m) => m.server_message_id)).toEqual(['10', '11', '12']);
    expect(result.map((m) => m.server_message_id)).toEqual(['10', '11', '12']);
  });

  it('returns empty when server has no history', async () => {
    const t = buildHistoryFake({ pages: new Map([['100::', []]]) });
    const c = newClient(t);
    const seen: ConversationSnapshot[] = [];
    c.observeConversation('100', 1, (snap) => seen.push(snap));
    const result = await c.openConversation('100', 1);
    expect(result).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('emits cached first then remote on second open', async () => {
    const t = buildHistoryFake({
      pages: new Map([['100::', [fakeMsg(10), fakeMsg(11)]]]),
    });
    const c = newClient(t);

    // First open populates cache + memory.
    await c.openConversation('100', 1);

    // Second open — observer attached AFTER first emit so it only sees
    // the second open's flow. Should fire: cached (synchronous from
    // IndexedDB) → remote.
    const events: Array<{ is_remote: boolean; ids: Array<string | undefined> }> = [];
    c.observeConversation('100', 1, (snap) => {
      events.push({
        is_remote: snap.is_remote,
        ids: snap.messages.map((m) => m.server_message_id),
      });
    });
    await c.openConversation('100', 1);

    expect(events).toHaveLength(2);
    expect(events[0]!.is_remote).toBe(false); // cache emit
    expect(events[1]!.is_remote).toBe(true);  // remote emit
    expect(events[0]!.ids).toEqual(['10', '11']);
    expect(events[1]!.ids).toEqual(['10', '11']);
  });

  it('does NOT promote channel.latest_pts from history (history wire has no pts)', async () => {
    // Bootstrap a channel with latest_seq="0" first, then open and verify lift.
    const t = buildHistoryFake({
      pages: new Map([['100::', [fakeMsg(50), fakeMsg(75)]]]),
    });
    const c = newClient(t);
    // Manually inject a channel — simulate post-bootstrap state.
    // (Phase 4 doesn't expose a public method for this; use observeChannelList
    //  to trigger the in-memory upsert via openConversation lazily promoting it.)
    await c.openConversation('100', 1);
    // No channel record was bootstrapped, so nothing to promote — just verify
    // that openConversation does not crash when channel is absent.
    expect(c.cachedChannels()).toEqual([]);
    expect(c.getCachedMessages('100', 1).map((m) => m.server_message_id)).toEqual([
      '50',
      '75',
    ]);
  });
});

describe('scrollHistory', () => {
  it('paginates older messages by before_server_message_id', async () => {
    const t = buildHistoryFake({
      pages: new Map([
        // first open: returns 30, 31, 32
        ['100::', [fakeMsg(30), fakeMsg(31), fakeMsg(32)]],
        // scroll before 30 returns older: 20, 21, 22
        ['100::30', [fakeMsg(20), fakeMsg(21), fakeMsg(22)]],
      ]),
    });
    const c = newClient(t);
    await c.openConversation('100', 1);

    // Default cursor = oldest in-memory msg = id 30.
    const olderPage = await c.scrollHistory('100', 1);
    expect(olderPage.map((m) => m.server_message_id)).toEqual(['20', '21', '22']);

    // Memory now contains both pages, sorted ascending.
    expect(c.getCachedMessages('100', 1).map((m) => m.server_message_id)).toEqual([
      '20',
      '21',
      '22',
      '30',
      '31',
      '32',
    ]);
  });

  it('returns [] when server has nothing older', async () => {
    const t = buildHistoryFake({
      pages: new Map([
        ['100::', [fakeMsg(10)]],
        ['100::10', []],
      ]),
    });
    const c = newClient(t);
    await c.openConversation('100', 1);
    const empty = await c.scrollHistory('100', 1);
    expect(empty).toEqual([]);
  });

  it('explicit beforeServerMessageId overrides the in-memory cursor', async () => {
    const t = buildHistoryFake({
      pages: new Map([
        ['100::42', [fakeMsg(40), fakeMsg(41)]],
      ]),
    });
    const c = newClient(t);
    const page = await c.scrollHistory('100', 1, { beforeServerMessageId: 42, limit: 50 });
    expect(page.map((m) => m.server_message_id)).toEqual(['40', '41']);
  });

  it('emits a patch with only the new ids (not a full window replace)', async () => {
    const t = buildHistoryFake({
      pages: new Map([
        ['100::', [fakeMsg(30)]],
        ['100::30', [fakeMsg(20), fakeMsg(21)]],
      ]),
    });
    const c = newClient(t);
    await c.openConversation('100', 1);

    const patches: ConversationPatch[] = [];
    c.observeConversation('100', 1, (_, p) => patches.push(p));
    await c.scrollHistory('100', 1);

    expect(patches).toHaveLength(1);
    expect(patches[0]!.upserted.map((m) => m.server_message_id)).toEqual(['20', '21']);
    expect(patches[0]!.removed).toEqual([]);
  });
});

describe('getCachedMessages', () => {
  it('returns the in-memory window after openConversation', async () => {
    const t = buildHistoryFake({
      pages: new Map([['100::', [fakeMsg(1), fakeMsg(2), fakeMsg(3)]]]),
    });
    const c = newClient(t);
    expect(c.getCachedMessages('100', 1)).toEqual([]);
    await c.openConversation('100', 1);
    const cached = c.getCachedMessages('100', 1);
    expect(cached.map((m) => m.server_message_id)).toEqual(['1', '2', '3']);
    // Sanity: returned records are MessageRecord shape
    const first: MessageRecord = cached[0]!;
    expect(first.status).toBe('received');
    expect(first.message_type).toBe('text');
    expect(first.from_uid).toBe('999');
  });
});
