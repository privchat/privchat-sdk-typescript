import { Packet, PacketType } from '@msgtrans/client';
import { describe, expect, it, vi } from 'vitest';
import {
  ENTITY_INVALIDATION_PUSH_TOPIC_V1,
  MessageType,
  PrivchatClient,
  encodeEntityInvalidationBatch,
  encodePushMessageRequest,
  type PushMessageRequest,
  type SequencedSdkEvent,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const invalidationPush = (): PushMessageRequest => ({
  setting: { need_receipt: false, signal: 0 },
  msg_key: 'entity-42',
  server_message_id: '9007199254740993',
  message_seq: 0,
  local_message_id: '0',
  stream_no: '',
  stream_seq: 0,
  stream_flag: 0,
  timestamp: 1_780_000_000,
  channel_id: '0',
  channel_type: 0,
  message_type: 5,
  expire: 0,
  topic: ENTITY_INVALIDATION_PUSH_TOPIC_V1,
  from_uid: '0',
  payload: encodeEntityInvalidationBatch({
    schema_version: 1,
    notification_id: '9007199254740993',
    committed_at_ms: 1_780_000_000_123,
    items: [{
      entity_type: 'friend',
      entity_id: '9007199254740995',
      target_version: '9007199254740997',
      mutation_hint: 'upsert',
    }],
  }),
  deleted: false,
});

const fireInvalidation = (transport: FakeTransport): void => {
  transport.fireMessage(new Packet({
    packetType: PacketType.OneWay,
    messageId: 0,
    bizType: MessageType.PushMessageRequest,
    payload: encodePushMessageRequest(invalidationPush()),
  }));
};

const replaceEntitySync = (
  client: PrivchatClient,
  sync: (entityType: string, scope?: string) => Promise<string | undefined>,
): void => {
  Object.defineProperty(client, 'syncInvalidatedEntity', { value: sync });
};

describe('entity invalidation control push', () => {
  it('coalesces duplicate hints, syncs first, and never emits a chat message', async () => {
    const transport = new FakeTransport();
    const client = new PrivchatClient({ transport });
    const sync = vi.fn().mockResolvedValue('42');
    replaceEntitySync(client, sync);
    const events: SequencedSdkEvent[] = [];
    client.observeEvents((event) => events.push(event));

    fireInvalidation(transport);
    fireInvalidation(transport);

    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(events.some((entry) => entry.event.type === 'entity_changed')).toBe(true);
    });
    expect(events.some((entry) => entry.event.type === 'message_received')).toBe(false);
    const changed = events.find((entry) => entry.event.type === 'entity_changed')?.event;
    expect(changed).toMatchObject({
      type: 'entity_changed',
      entity_type: 'friend',
      version: '42',
      mutation_hint: 'unknown',
    });
  });

  it('preserves a user scope for targeted incremental sync', async () => {
    const transport = new FakeTransport();
    const client = new PrivchatClient({ transport });
    const sync = vi.fn().mockResolvedValue('44');
    replaceEntitySync(client, sync);
    const push = invalidationPush();
    push.payload = encodeEntityInvalidationBatch({
      schema_version: 1,
      notification_id: '9007199254740994',
      committed_at_ms: 1_780_000_000_124,
      items: [{
        entity_type: 'user',
        entity_id: '100000023',
        scope: '100000023',
        target_version: '0',
        mutation_hint: 'upsert',
      }],
    });

    transport.fireMessage(new Packet({
      packetType: PacketType.OneWay,
      messageId: 0,
      bizType: MessageType.PushMessageRequest,
      payload: encodePushMessageRequest(push),
    }));

    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith('user', '100000023'));
  });

  it('retries a transient sync failure and emits only after success', async () => {
    const transport = new FakeTransport();
    const client = new PrivchatClient({ transport });
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce('43');
    replaceEntitySync(client, sync);
    const events: SequencedSdkEvent[] = [];
    client.observeEvents((event) => events.push(event));

    fireInvalidation(transport);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2), { timeout: 1_500 });
    expect(events.filter((entry) => entry.event.type === 'entity_changed')).toHaveLength(1);
    expect(events.some((entry) => entry.event.type === 'message_received')).toBe(false);
  });
});
