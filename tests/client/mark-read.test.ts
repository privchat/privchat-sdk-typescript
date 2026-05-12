// Phase 5A: client.markRead + read-cursor system push absorption.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  MarkReadValidationError,
  MessageType,
  PrivchatClient,
  decodeRpcRequest,
  encodePushMessageRequest,
  encodeRpcResponse,
  type ChannelRecord,
  type ConversationPatch,
  type MarkReadResult,
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

const errRpc = (code: number, message: string) =>
  encodeRpcResponse({ code, message });

/**
 * FakeTransport that intercepts entity/sync_entities (so bootstrapChannels
 * can populate a known channel) AND message/status/read_pts (so we can
 * shape the markRead response).
 */
function buildFake(opts: {
  channels: Array<{ channel_id: number; channel_type: number; name: string; unread_count: number }>;
  cursors?: Array<{ channel_id: number; reader_id: number; last_read_pts: number }>;
  markRead?: (req: { channel_id: number; read_pts: number }) => Uint8Array;
}): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType !== 17 /* RpcRequest */) return undefined;
    const req = decodeRpcRequest(pkt.payload);
    if (req.route === 'entity/sync_entities') {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as {
        entity_type: string;
      };
      if (body.entity_type === 'channel') {
        return okJson({
          items: opts.channels.map((c, i) => ({
            entity_id: String(c.channel_id),
            version: i + 1,
            deleted: false,
            payload: {
              channel_id: c.channel_id,
              channel_type: c.channel_type,
              channel_name: c.name,
              unread_count: c.unread_count,
            },
          })),
          next_version: opts.channels.length,
          has_more: false,
        });
      }
      if (body.entity_type === 'channel_read_cursor') {
        return okJson({
          items: (opts.cursors ?? []).map((c, i) => ({
            entity_id: `${c.channel_id}:${c.reader_id}`,
            version: i + 1,
            deleted: false,
            payload: {
              channel_id: c.channel_id,
              reader_id: c.reader_id,
              last_read_pts: c.last_read_pts,
            },
          })),
          next_version: (opts.cursors ?? []).length,
          has_more: false,
        });
      }
    }
    if (req.route === 'message/status/read_pts') {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as {
        channel_id: number;
        read_pts: number;
      };
      return opts.markRead?.(body) ?? okJson({
        status: 'success',
        channel_id: body.channel_id,
        last_read_pts: body.read_pts,
        accepted_read_pts: body.read_pts,
      });
    }
    return undefined;
  };
  return t;
}

const newClient = (transport: FakeTransport, withCache: boolean) => {
  client = new PrivchatClient({
    transport,
    cache: withCache ? { enabled: true, dbName: `mr-${++dbCounter}` } : undefined,
  });
  return client;
};

/** Synthesise a self_read_pts_updated push (PushMessageRequest with
 *  message_type=System and a JSON ChannelReadCursorNotification payload). */
function buildSelfReadPush(opts: {
  channel_id: string;
  channel_type: number;
  reader_id: string;
  read_pts: number;
}): PushMessageRequest {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      message_type: 'notification',
      content: 'channel read cursor updated',
      metadata: {
        notification_type: 'channel_read_cursor_updated',
        channel_id: Number(opts.channel_id),
        channel_type: opts.channel_type,
        reader_id: opts.reader_id,
        read_pts: opts.read_pts,
        visibility: 'self_read_pts_updated',
        updated_at: Date.now(),
      },
    }),
  );
  return {
    setting: { need_receipt: false, signal: 0 },
    msg_key: '',
    server_message_id: String(opts.read_pts),
    message_seq: opts.read_pts,
    local_message_id: '0',
    stream_no: '',
    stream_seq: 0,
    stream_flag: 0,
    timestamp: Math.floor(Date.now() / 1000),
    channel_id: opts.channel_id,
    channel_type: opts.channel_type,
    message_type: 5, // ContentMessageType::System
    expire: 0,
    topic: '',
    from_uid: opts.reader_id,
    payload,
    deleted: false,
  };
}

const buildPeerReadPush = (opts: {
  channel_id: string;
  channel_type: number;
  reader_id: string;
  read_pts: number;
}): PushMessageRequest => {
  const p = buildSelfReadPush(opts);
  // Mutate the JSON visibility to peer
  const decoded = JSON.parse(new TextDecoder().decode(p.payload));
  decoded.metadata.visibility = 'peer_read_pts_updated';
  return { ...p, payload: new TextEncoder().encode(JSON.stringify(decoded)) };
};

const fireOneWay = (t: FakeTransport, bizType: number, payload: Uint8Array) => {
  t.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0, bizType, payload }));
};

describe('markRead RPC', () => {
  it('cache-disabled: pure RPC, returns server response, does not touch cache', async () => {
    const t = buildFake({ channels: [] });
    const c = newClient(t, /* withCache */ false);
    const result = await c.markRead('100', 1, '50');
    expect(result.status).toBe('success');
    expect(result.accepted_read_pts).toBe(50);
  });

  it('cache-enabled: updates channels.read_pts and zeroes unread_count', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 5 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 10 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    const before = c.cachedChannels()[0]!;
    expect(before.read_pts).toBe('10');
    expect(before.unread_count).toBe(5);

    await c.markRead('100', 1, '50');

    const after = c.cachedChannels()[0]!;
    expect(after.read_pts).toBe('50');
    expect(after.unread_count).toBe(0);
  });

  it('uses server accepted_read_pts (post-clamp), not the request value', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
      // Server clamps requested 999 → 200 (max known seq)
      markRead: (req) =>
        okJson({
          status: 'success',
          channel_id: req.channel_id,
          last_read_pts: 200,
          accepted_read_pts: 200,
        }),
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    const result = await c.markRead('100', 1, '999');
    expect(result.accepted_read_pts).toBe(200);
    expect(c.cachedChannels()[0]!.read_pts).toBe('200');
  });

  it('falls back to last_read_pts when accepted_read_pts is absent', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
      markRead: (req) =>
        okJson({
          status: 'success',
          channel_id: req.channel_id,
          last_read_pts: 75,
          // accepted_read_pts intentionally absent
        }),
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    await c.markRead('100', 1, '99999');
    expect(c.cachedChannels()[0]!.read_pts).toBe('75');
  });

  it('idempotent: smaller read_pts does NOT regress local cursor', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    await c.markRead('100', 1, '100');
    expect(c.cachedChannels()[0]!.read_pts).toBe('100');

    // Second call with smaller seq — server clamps via GREATEST, returns
    // the existing high-water mark in last_read_pts.
    const t2 = t;
    t2.responder = ((prev) => (pkt: Packet) => {
      const req = decodeRpcRequest(pkt.payload);
      if (req.route === 'message/status/read_pts') {
        return okJson({
          status: 'success',
          channel_id: 100,
          last_read_pts: 100,
          accepted_read_pts: 100,
        });
      }
      return prev?.(pkt);
    })(t2.responder);

    await c.markRead('100', 1, '5');
    expect(c.cachedChannels()[0]!.read_pts).toBe('100'); // not regressed
  });

  it('throws MarkReadValidationError when server rejects (read_pts > current_pts)', async () => {
    const t = buildFake({
      channels: [],
      markRead: () => errRpc(10100, 'Validation: read_pts 超出频道 current_pts'),
    });
    const c = newClient(t, true);
    await expect(c.markRead('100', 1, '999')).rejects.toBeInstanceOf(MarkReadValidationError);
  });

  it('emits observeChannelList patch on read_pts advance', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 5 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    const snapshots: ChannelRecord[][] = [];
    c.observeChannelList((channels) => snapshots.push(channels));
    await c.markRead('100', 1, '50');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]![0]!.read_pts).toBe('50');
    expect(snapshots[0]![0]!.unread_count).toBe(0);
  });
});

describe('inbound self_read_pts_updated push', () => {
  it('cache-enabled: applies cursor update internally, NOT via L1 message_received', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 5 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    let pushCount = 0;
    c.onPushMessage(() => pushCount++);
    const patches: ConversationPatch[] = [];
    c.observeConversation('100', 1, (_, p) => patches.push(p));
    const cursorEvents: Array<{ read_pts: string; previous_read_pts?: string; reader_id: string }> = [];
    c.onReadCursorUpdated((event) => {
      cursorEvents.push({
        read_pts: event.read_pts,
        previous_read_pts: event.previous_read_pts,
        reader_id: event.reader_id,
      });
    });

    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(
        buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 50 }),
      ),
    );
    // applyReadCursorUpdate is async; let the .then chain settle.
    await new Promise((r) => setTimeout(r, 5));

    // System push must NOT surface as a normal message.
    expect(pushCount).toBe(0);
    // No conversation patch (it's not a message).
    expect(patches).toEqual([]);
    // The read cursor MUST advance.
    expect(c.cachedChannels()[0]!.read_pts).toBe('50');
    expect(c.cachedChannels()[0]!.unread_count).toBe(0);
    // Phase 5D: L1 event fires with previous + new read_pts.
    expect(cursorEvents).toEqual([
      { read_pts: '50', previous_read_pts: '0', reader_id: '999' },
    ]);
  });

  it('idempotent against repeat pushes — only the advancing one emits an event', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 5 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    const events: Array<{ read_pts: string }> = [];
    c.onReadCursorUpdated((event) => events.push({ read_pts: event.read_pts }));

    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 50 }),
    ));
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 30 }),
    ));
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 50 }),
    ));
    await new Promise((r) => setTimeout(r, 10));

    expect(c.cachedChannels()[0]!.read_pts).toBe('50');
    // Only the first push advanced the cursor; the others were no-op
    // MAX-merges and MUST NOT fire the event (Phase 5D Decisions §3).
    expect(events).toEqual([{ read_pts: '50' }]);
  });

  it('cache-disabled: silently dropped (no L1, no event)', async () => {
    const t = buildFake({ channels: [] });
    const c = newClient(t, false);
    let pushCount = 0;
    c.onPushMessage(() => pushCount++);
    let cursorEventCount = 0;
    c.onReadCursorUpdated(() => cursorEventCount++);
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 50 }),
    ));
    await new Promise((r) => setTimeout(r, 5));
    expect(pushCount).toBe(0);
    expect(cursorEventCount).toBe(0);
  });

  it('does NOT emit when the channel is not in cache (cold-start safety)', async () => {
    // No bootstrap → no channel record. The handler returns early
    // without emitting (advanced=false, no previous_read_pts).
    const t = buildFake({ channels: [] });
    const c = newClient(t, true);
    let cursorEventCount = 0;
    c.onReadCursorUpdated(() => cursorEventCount++);
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 50 }),
    ));
    await new Promise((r) => setTimeout(r, 5));
    expect(cursorEventCount).toBe(0);
  });
});

describe('inbound peer_read_pts_updated push', () => {
  it('writes peer_read_pts onto ChannelRecord, leaves other fields untouched, and emits peer_read_cursor_updated', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    const before = c.cachedChannels()[0]!;

    let pushCount = 0;
    c.onPushMessage(() => pushCount++);
    const peerEvents: Array<{ reader_id: string; read_pts: string; channel_type: number }> = [];
    c.onPeerReadCursorUpdated((event) => {
      peerEvents.push({
        reader_id: event.reader_id,
        read_pts: event.read_pts,
        channel_type: event.channel_type,
      });
    });

    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildPeerReadPush({ channel_id: '100', channel_type: 1, reader_id: '888', read_pts: 50 }),
    ));
    await new Promise((r) => setTimeout(r, 5));

    expect(pushCount).toBe(0);
    // peer_read_pts gets the new high-water mark; everything else stays.
    const after = c.cachedChannels()[0]!;
    expect(after.peer_read_pts).toBe('50');
    expect(after.read_pts).toBe(before.read_pts);
    expect(after.unread_count).toBe(before.unread_count);
    expect(after.latest_pts).toBe(before.latest_pts);
    expect(after.title).toBe(before.title);
    expect(peerEvents).toEqual([
      { reader_id: '888', read_pts: '50', channel_type: 1 },
    ]);
  });

  it('suppresses peer push when channel_type !== 1 and warns (defensive)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = buildFake({
        channels: [{ channel_id: 200, channel_type: 2, name: 'G', unread_count: 0 }],
      });
      const c = newClient(t, true);
      await c.bootstrapChannels();
      const peerEvents: unknown[] = [];
      c.onPeerReadCursorUpdated((event) => peerEvents.push(event));

      fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
        buildPeerReadPush({ channel_id: '200', channel_type: 2, reader_id: '888', read_pts: 50 }),
      ));
      await new Promise((r) => setTimeout(r, 5));

      expect(peerEvents).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('peer_read_pts_updated persists to ChannelRecord.peer_read_pts', () => {
  // Read receipts are projected at the UI/VM layer by comparing each
  // outbound message's pts against ChannelRecord.peer_read_pts. The SDK
  // MUST NOT mutate MessageRecord.status to a 'read' state — that's
  // not a member of MessageStatus and would conflate the send-state
  // machine with a delivery-receipt dimension. (See
  // `project_ts_sdk_positioning.md` and Rust SDK `channel_extra.peer_read_pts`.)

  it('persists peer cursor onto ChannelRecord and emits peer_read_cursor_updated', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    const peerEvents: Array<{ read_pts: string }> = [];
    c.onPeerReadCursorUpdated((e) => peerEvents.push({ read_pts: e.read_pts }));

    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(
        buildPeerReadPush({ channel_id: '100', channel_type: 1, reader_id: '888', read_pts: 50 }),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));

    const channel = c.cachedChannels().find((ch) => ch.channel_id === '100');
    expect(channel?.peer_read_pts).toBe('50');
    expect(peerEvents).toEqual([{ read_pts: '50' }]);
  });

  it('MAX-merges: smaller incoming cursor does not regress the persisted high-water mark', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    const fireAt = (read_pts: number) =>
      fireOneWay(
        t,
        MessageType.PushMessageRequest,
        encodePushMessageRequest(
          buildPeerReadPush({ channel_id: '100', channel_type: 1, reader_id: '888', read_pts }),
        ),
      );

    fireAt(50);
    await new Promise((r) => setTimeout(r, 5));
    fireAt(30); // out-of-order push
    await new Promise((r) => setTimeout(r, 5));

    const channel = c.cachedChannels().find((ch) => ch.channel_id === '100');
    expect(channel?.peer_read_pts).toBe('50'); // unchanged
  });

  it('does NOT emit when the cursor is unchanged (idempotent)', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    const peerEvents: Array<{ read_pts: string }> = [];
    c.onPeerReadCursorUpdated((e) => peerEvents.push({ read_pts: e.read_pts }));

    const fireAt20 = () =>
      fireOneWay(
        t,
        MessageType.PushMessageRequest,
        encodePushMessageRequest(
          buildPeerReadPush({ channel_id: '100', channel_type: 1, reader_id: '888', read_pts: 20 }),
        ),
      );
    fireAt20();
    await new Promise((r) => setTimeout(r, 5));
    fireAt20();
    await new Promise((r) => setTimeout(r, 5));

    expect(peerEvents).toHaveLength(1);
  });

  it('never mutates MessageRecord.status — read receipts are projected, not persisted', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).lastAuth = { user_id: '555', token: 't', device_id: 'd' };

    // Seed a self-sent row with pts=10 and an inbound row with pts=5.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (c as any).cacheStore as {
      upsertMessages: (
        ch: string,
        t: number,
        records: Array<Record<string, unknown>>,
        isRemote: boolean,
      ) => void;
    };
    store.upsertMessages(
      '100',
      1,
      [
        {
          channel_id: '100',
          channel_type: 1,
          server_message_id: 's1',
          from_uid: '555',
          message_type: '0',
          content: 'mine',
          payload: new Uint8Array(),
          pts: '10',
          timestamp: 1,
          status: 'sent',
        },
      ],
      false,
    );

    fireOneWay(
      t,
      MessageType.PushMessageRequest,
      encodePushMessageRequest(
        buildPeerReadPush({ channel_id: '100', channel_type: 1, reader_id: '888', read_pts: 50 }),
      ),
    );
    await new Promise((r) => setTimeout(r, 5));

    const row = c
      .getCachedMessages('100', 1)
      .find((m) => m.server_message_id === 's1');
    expect(row?.status).toBe('sent'); // unchanged — projection happens at VM layer
  });
});

describe('markRead RPC also emits self read_cursor_updated', () => {
  it('emits read_cursor_updated when local cache advances', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 5 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 10 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    const events: Array<{ read_pts: string; previous_read_pts?: string }> = [];
    c.onReadCursorUpdated((event) =>
      events.push({ read_pts: event.read_pts, previous_read_pts: event.previous_read_pts }),
    );

    await c.markRead('100', 1, '50');

    expect(events).toEqual([{ read_pts: '50', previous_read_pts: '10' }]);
  });

  it('does NOT emit when markRead is a no-op (incoming <= current)', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 50 }],
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();
    let eventCount = 0;
    c.onReadCursorUpdated(() => eventCount++);

    await c.markRead('100', 1, '30');

    expect(eventCount).toBe(0);
  });
});

describe('RPC + push convergence (MAX-merge)', () => {
  it('regardless of order, both paths converge to highest read_pts', async () => {
    const t = buildFake({
      channels: [{ channel_id: 100, channel_type: 1, name: 'A', unread_count: 0 }],
      cursors: [{ channel_id: 100, reader_id: 999, last_read_pts: 0 }],
      markRead: () =>
        okJson({ status: 'success', channel_id: 100, last_read_pts: 50, accepted_read_pts: 50 }),
    });
    const c = newClient(t, true);
    await c.bootstrapChannels();

    // Push arrives FIRST with 50 (e.g. another tab on same account beat us)
    fireOneWay(t, MessageType.PushMessageRequest, encodePushMessageRequest(
      buildSelfReadPush({ channel_id: '100', channel_type: 1, reader_id: '999', read_pts: 50 }),
    ));
    expect(c.cachedChannels()[0]!.read_pts).toBe('50');

    // Then this client's own RPC returns with the same accepted value
    await c.markRead('100', 1, '50');
    expect(c.cachedChannels()[0]!.read_pts).toBe('50'); // no double-update, no regress
  });
});
