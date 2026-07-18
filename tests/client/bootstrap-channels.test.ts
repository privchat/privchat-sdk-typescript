import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CacheDisabledError,
  PrivchatClient,
  decodeRpcRequest,
  encodeRpcResponse,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';
import { uniqueDbName } from './unique-db.js';
import { CacheDB, upsertChannels } from '../../src/cache/index.js';

let client: PrivchatClient | null = null;

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

/**
 * Builds a FakeTransport that serves entity/sync_entities for both
 * channel and channel_read_cursor entity_types. Each call returns the
 * configured page in one shot (has_more=false).
 */
function entitySyncFake(opts: {
  channelItems: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
  cursorItems: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
  userItems?: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
  groupItems?: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
  friendItems?: Array<{ entity_id: string; version: number; deleted?: boolean; payload?: unknown }>;
  /** Force user/group/friend sync to fail with an RPC error to verify
   *  bootstrapChannels still completes (best-effort behaviour). */
  failProfileSync?: boolean;
}): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    const req = decodeRpcRequest(pkt.payload);
    if (req.route !== 'entity/sync_entities') return undefined;
    const body = JSON.parse(new TextDecoder().decode(req.body)) as { entity_type: string };
    if (body.entity_type === 'channel') {
      return okJson({
        items: opts.channelItems.map((i) => ({ deleted: false, ...i })),
        next_version: opts.channelItems.length,
        has_more: false,
      });
    }
    if (body.entity_type === 'channel_read_cursor') {
      return okJson({
        items: opts.cursorItems.map((i) => ({ deleted: false, ...i })),
        next_version: opts.cursorItems.length,
        has_more: false,
      });
    }
    if (body.entity_type === 'user') {
      if (opts.failProfileSync) {
        return encodeRpcResponse({ code: 50000, message: 'profile sync down' });
      }
      const items = opts.userItems ?? [];
      return okJson({
        items: items.map((i) => ({ deleted: false, ...i })),
        next_version: items.length,
        has_more: false,
      });
    }
    if (body.entity_type === 'group') {
      if (opts.failProfileSync) {
        return encodeRpcResponse({ code: 50000, message: 'profile sync down' });
      }
      const items = opts.groupItems ?? [];
      return okJson({
        items: items.map((i) => ({ deleted: false, ...i })),
        next_version: items.length,
        has_more: false,
      });
    }
    if (body.entity_type === 'friend') {
      if (opts.failProfileSync) {
        return encodeRpcResponse({ code: 50000, message: 'profile sync down' });
      }
      const items = opts.friendItems ?? [];
      return okJson({
        // Pass through `deleted` flag verbatim so tombstone tests work;
        // default to `false` for normal rows.
        items: items.map((i) => ({ deleted: i.deleted ?? false, ...i })),
        next_version: items.length,
        has_more: false,
      });
    }
    return okJson({ items: [], next_version: 0, has_more: false });
  };
  return t;
}

describe('cache opt-in plumbing', () => {
  it('isCacheEnabled = false by default', () => {
    client = new PrivchatClient({ transport: new FakeTransport() });
    expect(client.isCacheEnabled()).toBe(false);
  });

  it('throws CacheDisabledError when cache APIs are called without opt-in', async () => {
    client = new PrivchatClient({ transport: new FakeTransport() });
    await expect(client.bootstrapChannels()).rejects.toBeInstanceOf(CacheDisabledError);
    expect(() => client!.cachedChannels()).toThrow(CacheDisabledError);
    expect(() => client!.observeChannelList(() => {})).toThrow(CacheDisabledError);
  });

  it('isCacheEnabled = true when constructor opts in', () => {
    client = new PrivchatClient({
      transport: new FakeTransport(),
      cache: { enabled: true, dbName: uniqueDbName('test') },
    });
    expect(client.isCacheEnabled()).toBe(true);
  });
});

describe('bootstrapChannels', () => {
  it('restores persisted unread badges before a failed network refresh', async () => {
    const dbName = uniqueDbName('cold-unread');
    const db = new CacheDB(dbName);
    await upsertChannels(db, [
      {
        channel_id: '12345',
        channel_type: 1,
        title: 'Alice',
        latest_pts: '9',
        read_pts: '4',
        unread_count: 5,
        updated_at: 1_700,
        sync_version: 7,
      },
    ]);
    db.close();

    const offline = new FakeTransport();
    offline.responder = () => {
      throw new Error('offline');
    };
    client = new PrivchatClient({
      transport: offline,
      cache: { enabled: true, dbName },
    });

    await expect(client.bootstrapChannels()).rejects.toThrow('offline');
    expect(client.cachedChannels()).toMatchObject([
      { channel_id: '12345', unread_count: 5, read_pts: '4' },
    ]);
  });

  it('joins channel + channel_read_cursor and writes ChannelRecord rows', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '12345',
          version: 1,
          payload: {
            channel_id: 12345,
            channel_type: 1,
            channel_name: 'Alice',
            unread_count: 3,
            last_msg_content: 'hi',
            last_msg_timestamp: 1_700,
          },
        },
        {
          entity_id: '67890',
          version: 2,
          payload: {
            channel_id: 67890,
            channel_type: 2,
            name: 'Group A',
            unread_count: 0,
            last_msg_content: 'welcome',
            last_msg_timestamp: 1_500,
          },
        },
      ],
      cursorItems: [
        {
          entity_id: '12345:999',
          version: 1,
          payload: {
            channel_id: 12345,
            channel_type: 1,
            reader_id: 999,
            last_read_pts: 100,
            updated_at: 1_700,
          },
        },
        // Note: 67890 has no cursor row → read_pts must default to "0".
      ],
    });

    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('bootstrap') },
    });
    const channels = await client.bootstrapChannels();

    expect(channels).toHaveLength(2);
    const direct = channels.find((c) => c.channel_id === '12345')!;
    expect(direct.channel_type).toBe(1);
    expect(direct.title).toBe('Alice');
    expect(direct.read_pts).toBe('100');
    expect(direct.unread_count).toBe(3);
    expect(direct.last_message_preview).toBe('hi');
    expect(direct.sync_version).toBe(1);

    const group = channels.find((c) => c.channel_id === '67890')!;
    expect(group.channel_type).toBe(2);
    expect(group.title).toBe('Group A');
    // No cursor row — must fallback to "0"
    expect(group.read_pts).toBe('0');
    expect(group.unread_count).toBe(0);
  });

  it('routes self vs peer cursor rows by reader_id and hydrates ChannelRecord.peer_read_pts (B-step)', async () => {
    // Server (post-B-step) returns BOTH self and peer cursor rows in the
    // same channel_read_cursor entity stream. Client must:
    //   - put reader_id===self  → ChannelRecord.read_pts
    //   - put reader_id===peer  → ChannelRecord.peer_read_pts (only for direct)
    //   - NOT emit peer_read_cursor_updated for baseline rows
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '12345',
          version: 1,
          payload: {
            channel_id: 12345,
            channel_type: 1,
            channel_name: 'Direct',
            unread_count: 0,
          },
        },
      ],
      cursorItems: [
        {
          entity_id: '12345:555',
          version: 1,
          payload: {
            channel_id: 12345,
            channel_type: 1,
            reader_id: 555,
            last_read_pts: 100,
            updated_at: 1_700,
          },
        },
        {
          entity_id: '12345:888',
          version: 2,
          payload: {
            channel_id: 12345,
            channel_type: 1,
            reader_id: 888,
            last_read_pts: 973,
            updated_at: 1_710,
          },
        },
      ],
    });

    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('peer-baseline') },
    });
    // Pretend we authenticated as 555. The lastAuth.user_id field is
    // what the bucket-routing logic compares against.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).lastAuth = { user_id: '555', token: 't', device_id: 'd' };

    // Baseline must NOT raise peer_read_cursor_updated — that event is
    // reserved for live push advances. Re-login should not look like
    // "the peer just read something."
    const peerEvents: unknown[] = [];
    client.onPeerReadCursorUpdated((e) => peerEvents.push(e));

    const channels = await client.bootstrapChannels();
    expect(channels).toHaveLength(1);
    const ch = channels[0]!;
    expect(ch.read_pts).toBe('100'); // self cursor
    expect(ch.peer_read_pts).toBe('973'); // peer cursor — the new field
    expect(peerEvents).toHaveLength(0); // baseline is silent
  });

  it('falls back to read_pts when reader_id is missing (legacy server / pre-B-step)', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '7',
          version: 1,
          payload: { channel_id: 7, channel_type: 1, channel_name: 'X', unread_count: 0 },
        },
      ],
      cursorItems: [
        {
          entity_id: '7:?',
          version: 1,
          payload: {
            channel_id: 7,
            channel_type: 1,
            // no reader_id — old server
            last_read_pts: 50,
            updated_at: 0,
          },
        },
      ],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('legacy') },
    });
    const channels = await client.bootstrapChannels();
    const ch = channels[0]!;
    expect(ch.read_pts).toBe('50'); // legacy: treat as self
    expect(ch.peer_read_pts).toBeUndefined();
  });

  it('R2A: bootstrap also hydrates user + group profile caches', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          payload: { channel_id: 1, channel_type: 1, channel_name: 'A', unread_count: 0 },
        },
      ],
      cursorItems: [],
      userItems: [
        {
          entity_id: '100',
          version: 1,
          payload: {
            user_id: 100,
            username: 'alice',
            nickname: 'Alice',
            avatar: 'https://cdn/alice.png', // server emits `avatar`, not `avatar_url`
            user_type: 0,
          },
        },
        {
          entity_id: '1',
          version: 2,
          payload: {
            user_id: 1,
            username: 'system',
            nickname: '系统通知',
            user_type: 1,
          },
        },
      ],
      groupItems: [
        {
          entity_id: '500',
          version: 3,
          payload: {
            group_id: 500,
            name: 'Engineering',
            avatar_url: 'https://cdn/eng.png',
            member_count: 12,
          },
        },
      ],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('r2a-bootstrap') },
    });
    await client.bootstrapChannels();
    // bootstrap kicks profile sync as fire-and-forget; let it settle.
    await new Promise((r) => setTimeout(r, 30));

    const users = client.cachedUsers();
    expect(users).toHaveLength(2);
    const alice = client.cachedUser('100');
    expect(alice?.username).toBe('alice');
    expect(alice?.nickname).toBe('Alice');
    expect(alice?.avatar_url).toBe('https://cdn/alice.png'); // normalised from `avatar`
    expect(alice?.user_type).toBe(0);
    expect(alice?.is_friend).toBe(false); // R2.1 territory
    expect(alice?.sync_version).toBe(1);

    const sys = client.cachedUser('1');
    expect(sys?.user_type).toBe(1);

    const eng = client.cachedGroup('500');
    expect(eng?.name).toBe('Engineering');
    expect(eng?.avatar_url).toBe('https://cdn/eng.png');
    expect(eng?.member_count).toBe(12);
  });

  it('R2A: profile sync failure does NOT block bootstrap (best-effort)', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          payload: { channel_id: 1, channel_type: 1, channel_name: 'A', unread_count: 0 },
        },
      ],
      cursorItems: [],
      failProfileSync: true,
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('r2a-fail') },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const channels = await client.bootstrapChannels();
      // Channel list still succeeds even though user/group RPC failed.
      expect(channels).toHaveLength(1);
      // Wait for the fire-and-forget profile sync to fail + warn.
      await new Promise((r) => setTimeout(r, 30));
      expect(client.cachedUsers()).toHaveLength(0);
      expect(client.cachedGroups()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('R2.1: bootstrap hydrates friendships, flattening alias from payload.user.alias', async () => {
    const t = entitySyncFake({
      channelItems: [],
      cursorItems: [],
      friendItems: [
        {
          entity_id: '500',
          version: 1,
          payload: {
            user_id: 500,
            uid: 500,
            is_pinned: false,
            created_at: 1_700,
            updated_at: 1_710,
            user: {
              username: 'wangwu',
              nickname: '王五',
              alias: '老王', // ← caller's remark for this friend
              avatar: 'https://cdn/wang.png',
            },
          },
        },
        {
          entity_id: '700',
          version: 2,
          payload: {
            user_id: 700,
            user: {
              username: 'no_alias',
              nickname: 'No Alias',
              // alias absent — caller hasn't set a remark
            },
          },
        },
      ],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('r2-1-bootstrap') },
    });
    await client.bootstrapChannels();
    await new Promise((r) => setTimeout(r, 30));

    const friendships = client.cachedFriendships();
    expect(friendships).toHaveLength(2);
    const wang = client.cachedFriendship('500');
    expect(wang?.alias).toBe('老王');
    expect(wang?.created_at).toBe(1_700);
    expect(wang?.updated_at).toBe(1_710);
    expect(wang?.sync_version).toBe(1);

    // Empty / missing alias collapses to undefined (not '').
    const noAlias = client.cachedFriendship('700');
    expect(noAlias?.alias).toBeUndefined();
  });

  it('R2.1: tombstones (deleted=true) drop the friendship row but leave UserRecord intact', async () => {
    // First sync: friendship + user profile both present.
    const t = entitySyncFake({
      channelItems: [],
      cursorItems: [],
      userItems: [
        {
          entity_id: '500',
          version: 1,
          payload: { user_id: 500, username: 'wangwu', nickname: '王五' },
        },
      ],
      friendItems: [
        {
          entity_id: '500',
          version: 1,
          payload: { user_id: 500, user: { username: 'wangwu', alias: '老王' } },
        },
      ],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('r2-1-tombstone') },
    });
    await client.bootstrapChannels();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.cachedFriendship('500')?.alias).toBe('老王');

    // Second sync: tombstone for the same uid.
    t.responder = (pkt) => {
      const req = decodeRpcRequest(pkt.payload);
      if (req.route !== 'entity/sync_entities') return undefined;
      const body = JSON.parse(new TextDecoder().decode(req.body)) as {
        entity_type: string;
      };
      if (body.entity_type === 'friend') {
        return okJson({
          items: [
            {
              entity_id: '500',
              version: 2,
              deleted: true,
              payload: null,
            },
          ],
          next_version: 2,
          has_more: false,
        });
      }
      return okJson({ items: [], next_version: 0, has_more: false });
    };
    await client.bootstrapChannels();
    await new Promise((r) => setTimeout(r, 30));

    // Friendship dropped — UserRecord stays.
    expect(client.cachedFriendship('500')).toBeUndefined();
    expect(client.cachedUser('500')?.username).toBe('wangwu');
  });

  it('R2.1: friend sync failure does NOT block bootstrap', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          payload: { channel_id: 1, channel_type: 1, channel_name: 'A', unread_count: 0 },
        },
      ],
      cursorItems: [],
      failProfileSync: true,
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('r2-1-fail') },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const channels = await client.bootstrapChannels();
      expect(channels).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 30));
      expect(client.cachedFriendships()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('R2A: observeUserList / observeGroupList fire after bootstrap', async () => {
    const t = entitySyncFake({
      channelItems: [],
      cursorItems: [],
      userItems: [{ entity_id: '7', version: 1, payload: { user_id: 7, username: 'g' } }],
      groupItems: [{ entity_id: '9', version: 1, payload: { group_id: 9, name: 'G' } }],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('r2a-observe') },
    });
    let userSnapshot = -1;
    let groupSnapshot = -1;
    client.observeUserList((u) => {
      userSnapshot = u.length;
    });
    client.observeGroupList((g) => {
      groupSnapshot = g.length;
    });
    await client.bootstrapChannels();
    await new Promise((r) => setTimeout(r, 30));
    expect(userSnapshot).toBe(1);
    expect(groupSnapshot).toBe(1);
  });

  it('emits channel-list updates to observers', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          payload: { channel_id: 1, channel_type: 1, channel_name: 'A', unread_count: 0 },
        },
      ],
      cursorItems: [],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('obs') },
    });
    let snapshot: number | null = null;
    client.observeChannelList((channels) => {
      snapshot = channels.length;
    });
    await client.bootstrapChannels();
    expect(snapshot).toBe(1);
  });

  it('skips deleted (tombstone) entity items', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          deleted: false,
          payload: { channel_id: 1, channel_type: 1, channel_name: 'A' },
        },
        {
          entity_id: '2',
          version: 2,
          deleted: true,
          payload: undefined,
        },
      ],
      cursorItems: [],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('tomb') },
    });
    const channels = await client.bootstrapChannels();
    expect(channels.map((c) => c.channel_id)).toEqual(['1']);
  });

  it('uses payload.type as channel_type fallback when channel_type missing', async () => {
    // Server's serde rename = "type" alias for channel_type — verify the join works.
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          payload: { channel_id: 1, type: 5, channel_name: 'X' },
        },
      ],
      cursorItems: [],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('type') },
    });
    const channels = await client.bootstrapChannels();
    expect(channels[0]!.channel_type).toBe(5);
  });

  it('cachedChannels returns the in-memory list after bootstrap', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '1',
          version: 1,
          payload: { channel_id: 1, channel_type: 1, channel_name: 'A', last_msg_timestamp: 100 },
        },
        {
          entity_id: '2',
          version: 2,
          payload: { channel_id: 2, channel_type: 1, channel_name: 'B', last_msg_timestamp: 200 },
        },
      ],
      cursorItems: [],
    });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('cached') },
    });
    expect(client.cachedChannels()).toEqual([]);
    await client.bootstrapChannels();
    // Sorted by updated_at desc
    expect(client.cachedChannels().map((c) => c.channel_id)).toEqual(['2', '1']);
  });
});

describe('bootstrapChannels in-flight coalescing (P0-12 storm control)', () => {
  it('concurrent callers share one sweep; a later call runs fresh', async () => {
    const t = entitySyncFake({
      channelItems: [
        {
          entity_id: '12345',
          version: 1,
          payload: {
            channel_id: 12345,
            channel_type: 1,
            channel_name: 'Alice',
            unread_count: 0,
            last_msg_content: 'hi',
            last_msg_timestamp: 1_700,
          },
        },
      ],
      cursorItems: [],
    });
    // Count channel-entity sweeps through the fake.
    let channelSweeps = 0;
    const inner = t.responder!;
    t.responder = (pkt) => {
      const req = decodeRpcRequest(pkt.payload);
      if (req.route === 'entity/sync_entities') {
        const body = JSON.parse(new TextDecoder().decode(req.body)) as { entity_type: string };
        if (body.entity_type === 'channel') channelSweeps++;
      }
      return inner(pkt);
    };

    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: uniqueDbName('coalesce') },
    });
    await client.connect();

    const [a, b] = await Promise.all([
      client.bootstrapChannels(),
      client.bootstrapChannels(),
    ]);
    expect(channelSweeps).toBe(1);
    expect(b).toEqual(a);

    await client.bootstrapChannels();
    expect(channelSweeps).toBe(2);
  });
});
