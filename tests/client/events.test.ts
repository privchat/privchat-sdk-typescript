// L1 event bus + history.

import { describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  encodeAuthorizationResponse,
  encodePongResponse,
  encodePushBatchRequest,
  encodePushMessageRequest,
  MessageType,
  PrivchatClient,
  type SequencedSdkEvent,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const samplePush = () =>
  encodePushMessageRequest({
    setting: { need_receipt: true, signal: 0 },
    msg_key: 'k',
    server_message_id: '1',
    message_seq: 1,
    local_message_id: '1',
    stream_no: '',
    stream_seq: 0,
    stream_flag: 0,
    timestamp: 0,
    channel_id: '1',
    channel_type: 1,
    message_type: 0,
    expire: 0,
    topic: '',
    from_uid: '1',
    payload: new Uint8Array(),
    deleted: false,
  });

const fireOneWay = (t: FakeTransport, bizType: number, payload: Uint8Array) => {
  t.fireMessage(new Packet({ packetType: PacketType.OneWay, messageId: 0, bizType, payload }));
};

describe('observeEvents fans out L1 events with sequence ids', () => {
  it('assigns monotonic sequence_id and timestamp', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: SequencedSdkEvent[] = [];
    client.observeEvents((env) => seen.push(env));

    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    fireOneWay(t, MessageType.PushMessageRequest, samplePush());

    expect(seen).toHaveLength(2);
    expect(seen[0]!.sequence_id).toBe(1);
    expect(seen[1]!.sequence_id).toBe(2);
    expect(seen[1]!.timestamp_ms).toBeGreaterThanOrEqual(seen[0]!.timestamp_ms);
  });

  it('emits message_received / message_batch_received / pong_received', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const types: string[] = [];
    client.observeEvents((env) => types.push(env.event.type));

    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    fireOneWay(t, MessageType.PushBatchRequest, encodePushBatchRequest({ messages: [] }));
    fireOneWay(t, MessageType.PongResponse, encodePongResponse({ timestamp: 1 }));

    expect(types).toEqual(['message_received', 'message_batch_received', 'pong_received']);
  });

  it('lastEventSequenceId tracks the highest emitted id', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    expect(client.lastEventSequenceId()).toBe(0);
    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    expect(client.lastEventSequenceId()).toBe(1);
  });

  it('handler errors do not break the bus', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const survivor: number[] = [];
    client.observeEvents(() => {
      throw new Error('boom');
    });
    client.observeEvents((env) => survivor.push(env.sequence_id));

    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    expect(survivor).toEqual([1]);
  });

  it('returned unsubscribe detaches the listener', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    const seen: number[] = [];
    const off = client.observeEvents((env) => seen.push(env.sequence_id));
    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    off();
    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    expect(seen).toEqual([1]);
  });
});

describe('history buffers (recentEvents / eventsSince)', () => {
  it('recentEvents returns last N in oldest-first order', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    for (let i = 0; i < 5; i++) fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    const last3 = client.recentEvents(3);
    expect(last3.map((e) => e.sequence_id)).toEqual([3, 4, 5]);
  });

  it('eventsSince returns only newer-than-cursor entries, capped to limit', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    for (let i = 0; i < 5; i++) fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    const after2 = client.eventsSince(2, 100);
    expect(after2.map((e) => e.sequence_id)).toEqual([3, 4, 5]);
    const next2 = client.eventsSince(0, 2);
    expect(next2.map((e) => e.sequence_id)).toEqual([1, 2]);
  });

  it('respects historyLimit and drops the oldest', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t, eventHistoryLimit: 3 });
    for (let i = 0; i < 5; i++) fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    const all = client.recentEvents(10);
    expect(all.map((e) => e.sequence_id)).toEqual([3, 4, 5]);
  });
});

describe('compat helpers (onPushMessage / onPushBatch / onPong) still work', () => {
  it('onPushMessage receives PushMessageRequest', () => {
    const t = new FakeTransport();
    const client = new PrivchatClient({ transport: t });
    let seen = 0;
    client.onPushMessage((m) => {
      expect(m.server_message_id).toBe('1');
      seen++;
    });
    fireOneWay(t, MessageType.PushMessageRequest, samplePush());
    expect(seen).toBe(1);
  });
});

describe('connection_state_changed events', () => {
  it('emits on connect / authenticate-success / disconnect', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    const client = new PrivchatClient({ transport: t });
    const states: string[] = [];
    client.onConnectionStateChanged((e) => states.push(e.state));

    await client.connect();
    await client.authenticate('1', 't', 'd');
    await client.disconnect();

    expect(states).toEqual([
      'connecting',
      'connected',
      'authenticating',
      'authenticated',
      'closing',
      'disconnected',
    ]);
  });
});

// ----- Phase 5D-1c: read cursor event helpers -----

describe('onReadCursorUpdated / onPeerReadCursorUpdated helpers', () => {
  // The push handler that materialises these events is wired in 5D-1d.
  // Until then the unit test injects events directly via the private
  // bus to exercise the filter contract — same shape we use to test
  // any per-type accessor before its source is wired.
  const emit = (client: PrivchatClient, event: import('../../src/index.js').SdkEvent) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).bus.emit(event);
  };

  it('onReadCursorUpdated fires only on read_cursor_updated', () => {
    const client = new PrivchatClient({ transport: new FakeTransport() });
    const seen: Array<{ type: string; read_pts: string }> = [];
    client.onReadCursorUpdated((event) => {
      seen.push({ type: event.type, read_pts: event.read_pts });
    });

    emit(client, {
      type: 'read_cursor_updated',
      channel_id: '100',
      channel_type: 1,
      reader_id: 'me',
      read_pts: '7',
      previous_read_pts: '3',
      updated_at: 1_700_000_000_000,
    });
    // Decoy events that must NOT pass through.
    emit(client, {
      type: 'peer_read_cursor_updated',
      channel_id: '100',
      channel_type: 1,
      reader_id: 'peer',
      read_pts: '9',
    });
    emit(client, {
      type: 'connection_state_changed',
      state: 'connected',
    });

    expect(seen).toEqual([{ type: 'read_cursor_updated', read_pts: '7' }]);
  });

  it('onPeerReadCursorUpdated fires only on peer_read_cursor_updated', () => {
    const client = new PrivchatClient({ transport: new FakeTransport() });
    const seen: Array<{ reader_id: string; read_pts: string }> = [];
    client.onPeerReadCursorUpdated((event) => {
      seen.push({ reader_id: event.reader_id, read_pts: event.read_pts });
    });

    emit(client, {
      type: 'peer_read_cursor_updated',
      channel_id: '200',
      channel_type: 1,
      reader_id: 'peer-1',
      read_pts: '42',
    });
    emit(client, {
      type: 'read_cursor_updated',
      channel_id: '200',
      channel_type: 1,
      reader_id: 'me',
      read_pts: '50',
    });

    expect(seen).toEqual([{ reader_id: 'peer-1', read_pts: '42' }]);
  });

  it('unsubscribe stops further callbacks on either helper', () => {
    const client = new PrivchatClient({ transport: new FakeTransport() });
    const selfSeen: number[] = [];
    const peerSeen: number[] = [];
    const offSelf = client.onReadCursorUpdated(() => {
      selfSeen.push(selfSeen.length);
    });
    const offPeer = client.onPeerReadCursorUpdated(() => {
      peerSeen.push(peerSeen.length);
    });

    emit(client, {
      type: 'read_cursor_updated',
      channel_id: '1',
      channel_type: 1,
      reader_id: 'me',
      read_pts: '1',
    });
    emit(client, {
      type: 'peer_read_cursor_updated',
      channel_id: '1',
      channel_type: 1,
      reader_id: 'peer',
      read_pts: '1',
    });
    expect(selfSeen).toEqual([0]);
    expect(peerSeen).toEqual([0]);

    offSelf();
    offPeer();

    emit(client, {
      type: 'read_cursor_updated',
      channel_id: '1',
      channel_type: 1,
      reader_id: 'me',
      read_pts: '2',
    });
    emit(client, {
      type: 'peer_read_cursor_updated',
      channel_id: '1',
      channel_type: 1,
      reader_id: 'peer',
      read_pts: '2',
    });
    expect(selfSeen).toEqual([0]);
    expect(peerSeen).toEqual([0]);
  });
});
