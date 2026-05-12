import { describe, expect, it, vi } from 'vitest';
import { MessageStore } from '../../src/cache/message-store.js';
import type {
  ChannelRecord,
  ConversationPatch,
  ConversationSnapshot,
  MessageRecord,
} from '../../src/cache/types.js';

const channel = (overrides: Partial<ChannelRecord> = {}): ChannelRecord => ({
  channel_id: '12345',
  channel_type: 1,
  title: 't',
  latest_pts: '0',
  read_pts: '0',
  unread_count: 0,
  updated_at: 1_000,
  sync_version: 1,
  ...overrides,
});

/** Build a received MessageRecord. `id` drives both server_message_id
 *  (for identity) and timestamp (for ordering) — keeps the test
 *  assertions intuitive: a message with id=N sorts before id=N+1. */
const msg = (
  id: string,
  overrides: Partial<MessageRecord> = {},
): MessageRecord => ({
  channel_id: '12345',
  channel_type: 1,
  server_message_id: `s-${id}`,
  from_uid: '999',
  message_type: 'text',
  content: `body ${id}`,
  payload: new Uint8Array(),
  timestamp: Number(id),
  status: 'received',
  revoked: false,
  ...overrides,
});

describe('channel state', () => {
  it('upsertChannel + listChannels orders by updated_at desc', () => {
    const s = new MessageStore();
    s.upsertChannel(channel({ channel_id: 'a', updated_at: 100 }));
    s.upsertChannel(channel({ channel_id: 'b', updated_at: 300 }));
    s.upsertChannel(channel({ channel_id: 'c', updated_at: 200 }));
    expect(s.listChannels().map((c) => c.channel_id)).toEqual(['b', 'c', 'a']);
  });

  it('observeChannelList fires on each upsert', () => {
    const s = new MessageStore();
    const seen: number[] = [];
    s.observeChannelList((channels) => seen.push(channels.length));
    s.upsertChannel(channel({ channel_id: 'a' }));
    s.upsertChannel(channel({ channel_id: 'b' }));
    expect(seen).toEqual([1, 2]);
  });

  it('observeChannelList returns unsubscribe', () => {
    const s = new MessageStore();
    const seen: number[] = [];
    const off = s.observeChannelList((channels) => seen.push(channels.length));
    s.upsertChannel(channel({ channel_id: 'a' }));
    off();
    s.upsertChannel(channel({ channel_id: 'b' }));
    expect(seen).toEqual([1]);
  });
});

describe('replaceWindow', () => {
  it('sorts ascending by timestamp even when input is unordered', () => {
    const s = new MessageStore();
    let snap: ConversationSnapshot | null = null;
    s.observeConversation('12345', 1, (env) => (snap = env));
    s.replaceWindow('12345', 1, [msg('5'), msg('1'), msg('3')], true);
    expect(snap!.messages.map((m) => m.server_message_id)).toEqual(['s-1', 's-3', 's-5']);
    expect(snap!.is_remote).toBe(true);
  });

  it('emits a patch listing newly upserted records', () => {
    const s = new MessageStore();
    let patch: ConversationPatch | null = null;
    s.observeConversation('12345', 1, (_, p) => (patch = p));
    s.replaceWindow('12345', 1, [msg('1'), msg('2')], true);
    expect(patch!.upserted.map((m) => m.server_message_id)).toEqual(['s-1', 's-2']);
    expect(patch!.removed).toEqual([]);
  });

  it('preserves messages outside the new window range', () => {
    const s = new MessageStore();
    s.replaceWindow('12345', 1, [msg('100'), msg('101'), msg('102')], true);
    // simulate scroll-up: replace older window only
    s.replaceWindow('12345', 1, [msg('50'), msg('51')], true);
    const all = s.getMessages('12345', 1);
    expect(all.map((m) => m.server_message_id)).toEqual([
      's-50',
      's-51',
      's-100',
      's-101',
      's-102',
    ]);
  });

  it('uses numeric (not lexical) timestamp ordering', () => {
    const s = new MessageStore();
    s.replaceWindow('12345', 1, [msg('100'), msg('9'), msg('21')], true);
    expect(s.getMessages('12345', 1).map((m) => m.server_message_id)).toEqual([
      's-9',
      's-21',
      's-100',
    ]);
  });
});

describe('upsertMessage', () => {
  it('inserts a new message and emits a single-record patch', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.observeConversation('12345', 1, (_, p) => patches.push(p));
    s.upsertMessage(msg('1'), false);
    s.upsertMessage(msg('2'), true);
    expect(patches).toHaveLength(2);
    expect(patches[0]!.upserted[0]!.server_message_id).toBe('s-1');
    expect(patches[0]!.is_remote).toBe(false);
    expect(patches[1]!.is_remote).toBe(true);
  });

  it('dedupes by record_key (no patch when content identical)', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.observeConversation('12345', 1, (_, p) => patches.push(p));
    s.upsertMessage(msg('1'), false);
    s.upsertMessage(msg('1'), false); // identical
    expect(patches).toHaveLength(1);
  });

  it('emits patch when content/status changes (e.g. pending → sent)', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.observeConversation('12345', 1, (_, p) => patches.push(p));
    s.upsertMessage(msg('1', { status: 'pending' }), false);
    s.upsertMessage(msg('1', { status: 'sent' }), false);
    expect(patches).toHaveLength(2);
    expect(patches[1]!.upserted[0]!.status).toBe('sent');
  });
});

describe('replaceMessage (local-echo ack flow)', () => {
  it('record_key change emits removed=[oldKey] + upserted=[acked]', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.observeConversation('12345', 1, (_, p) => patches.push(p));

    // Pending insert keyed by local_message_id (record_key = "l:local-1").
    const pending: MessageRecord = {
      channel_id: '12345',
      channel_type: 1,
      local_message_id: 'local-1',
      from_uid: '999',
      message_type: 'text',
      content: 'hi',
      payload: new Uint8Array(),
      timestamp: 99,
      status: 'pending',
    };
    s.upsertMessage(pending, false);

    // Server ack — same row, identity flips to server_message_id
    // (record_key = "s:srv-100").
    const acked: MessageRecord = {
      ...pending,
      server_message_id: 'srv-100',
      pts: '100',
      status: 'sent',
    };
    s.replaceMessage('12345', 1, 'l:local-1', acked, true);

    expect(patches).toHaveLength(2);
    expect(patches[1]!.removed).toEqual(['l:local-1']);
    expect(patches[1]!.upserted[0]!.server_message_id).toBe('srv-100');
    expect(s.getMessages('12345', 1).map((m) => m.server_message_id)).toEqual(['srv-100']);
  });

  it('no removed entry when record_key is unchanged', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.observeConversation('12345', 1, (_, p) => patches.push(p));

    s.upsertMessage(msg('1', { status: 'pending' }), false);
    s.replaceMessage('12345', 1, 's:s-1', msg('1', { status: 'sent' }), true);

    expect(patches[1]!.removed).toEqual([]);
  });

  it('dedupes by NEW record_key too — handles the push-arrived-before-ACK race', () => {
    // Setup: push for our own message arrived first (status=received,
    // content=''). Then the local-echo ACK swap runs replaceMessage with
    // pendingKey='l:local-1' and acked.record_key='s:srv-100'. Without
    // the new-key dedup the buffer would end up with TWO rows under
    // record_key='s:srv-100' (the push + the acked).
    const s = new MessageStore();
    // Step 1: push lands first.
    const pushed: MessageRecord = {
      channel_id: '12345',
      channel_type: 1,
      server_message_id: 'srv-100',
      from_uid: '999',
      message_type: 'text',
      content: '',
      payload: new Uint8Array(),
      timestamp: 100,
      status: 'received',
    };
    s.upsertMessage(pushed, true);

    // Step 2: local echo (pending) lands.
    const pending: MessageRecord = {
      channel_id: '12345',
      channel_type: 1,
      local_message_id: 'local-1',
      from_uid: '999',
      message_type: 'text',
      content: 'hi',
      payload: new Uint8Array(),
      timestamp: 99,
      status: 'pending',
    };
    s.upsertMessage(pending, false);

    // Step 3: ACK swap.
    const acked: MessageRecord = {
      ...pending,
      server_message_id: 'srv-100',
      status: 'sent',
    };
    s.replaceMessage('12345', 1, 'l:local-1', acked, false);

    // Buffer must contain exactly one row (the acked) — no duplicate
    // under s:srv-100, no leftover pending under l:local-1.
    const messages = s.getMessages('12345', 1);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.server_message_id).toBe('srv-100');
    expect(messages[0]!.status).toBe('sent');
    expect(messages[0]!.content).toBe('hi');
  });
});

describe('removeMessage (revoke / delete)', () => {
  it('drops the record and emits a removed patch', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.upsertMessage(msg('1'), false);
    s.upsertMessage(msg('2'), false);
    s.observeConversation('12345', 1, (_, p) => patches.push(p));
    s.removeMessage('12345', 1, 's:s-1');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.removed).toEqual(['s:s-1']);
    expect(patches[0]!.upserted).toEqual([]);
    expect(s.getMessages('12345', 1).map((m) => m.server_message_id)).toEqual(['s-2']);
  });

  it('no-op when record_key absent', () => {
    const s = new MessageStore();
    const patches: ConversationPatch[] = [];
    s.observeConversation('12345', 1, (_, p) => patches.push(p));
    s.removeMessage('12345', 1, 's:nope');
    expect(patches).toEqual([]);
  });
});

describe('observers', () => {
  it('fan out to all listeners; throwing listener does not break others', () => {
    const s = new MessageStore();
    const seen: string[] = [];
    s.observeConversation('12345', 1, () => {
      throw new Error('boom');
    });
    s.observeConversation('12345', 1, (_, p) =>
      seen.push(p.upserted[0]!.server_message_id!),
    );
    s.upsertMessage(msg('1'), false);
    expect(seen).toEqual(['s-1']);
  });

  it('unsubscribe stops further emits', () => {
    const s = new MessageStore();
    const seen: string[] = [];
    const off = s.observeConversation('12345', 1, (_, p) =>
      seen.push(p.upserted[0]!.server_message_id!),
    );
    s.upsertMessage(msg('1'), false);
    off();
    s.upsertMessage(msg('2'), false);
    expect(seen).toEqual(['s-1']);
    expect(s.listenerCount('12345', 1)).toBe(0);
  });

  it('listeners are scoped per channel_id (channel_type does not split the conversation)', () => {
    // Conversation identity is channel_id alone. Two observers registered
    // against the same channel_id — even if they pass different
    // channel_type — both belong to the same conversation and both fire
    // for every message in that conversation.
    const s = new MessageStore();
    const a: string[] = [];
    const b: string[] = [];
    s.observeConversation('12345', 1, (_, p) =>
      a.push(p.upserted[0]!.server_message_id!),
    );
    s.observeConversation('12345', 2, (_, p) =>
      b.push(p.upserted[0]!.server_message_id!),
    );
    s.upsertMessage(msg('1', { channel_id: '12345', channel_type: 1 }), false);
    s.upsertMessage(msg('2', { channel_id: '12345', channel_type: 2 }), false);
    // Both observers belong to channel_id=12345 and see both messages.
    expect(a).toEqual(['s-1', 's-2']);
    expect(b).toEqual(['s-1', 's-2']);
  });

  it('upsertChannel collapses same channel_id across channel_type drift (latest wins, with warning)', () => {
    const s = new MessageStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.upsertChannel(channel({ channel_id: '100', channel_type: 1, title: 'first' }));
    s.upsertChannel(channel({ channel_id: '100', channel_type: 2, title: 'second' }));
    const list = s.listChannels();
    expect(list.filter((c) => c.channel_id === '100')).toHaveLength(1);
    expect(list[0]?.title).toBe('second');
    expect(list[0]?.channel_type).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/channel_type drift for channel_id=100/);
    warn.mockRestore();
  });
});

describe('clear', () => {
  it('wipes channels + buffers and notifies the channel list observer', () => {
    const s = new MessageStore();
    const lists: ChannelRecord[][] = [];
    s.observeChannelList((c) => lists.push(c));
    s.upsertChannel(channel({ channel_id: 'a' }));
    s.upsertMessage(msg('1'), false);
    s.clear();
    expect(s.listChannels()).toEqual([]);
    expect(s.getMessages('12345', 1)).toEqual([]);
    expect(lists.map((l) => l.length)).toEqual([1, 0]);
  });
});
