import { afterEach, describe, expect, it } from 'vitest';
import { CacheDB } from '../../src/cache-idb.js';
import {
  PrivchatClient,
  decodeRpcRequest,
  encodeRpcResponse,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';
import { uniqueDbName } from './unique-db.js';

let client: PrivchatClient | null = null;

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

const okJson = (data: unknown) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(JSON.stringify(data)),
  });

/**
 * 记录每一次 `entity/sync_entities` 的 (entity_type, scope)，用来断言
 * **定向**补齐：缺哪个对端补哪个，不能退化成全量 user sync。
 */
function scopeRecordingTransport(opts: {
  channelItems: Array<{ entity_id: string; version: number; payload: unknown }>;
  /** scope 命中时返回的 user 实体；未列出的 scope 返回空页。 */
  scopedUsers?: Record<string, unknown>;
}): { transport: FakeTransport; calls: Array<{ entity_type: string; scope?: string }> } {
  const calls: Array<{ entity_type: string; scope?: string }> = [];
  const t = new FakeTransport();
  t.responder = (pkt) => {
    const req = decodeRpcRequest(pkt.payload);
    if (req.route !== 'entity/sync_entities') return undefined;
    const body = JSON.parse(new TextDecoder().decode(req.body)) as {
      entity_type: string;
      scope?: string;
    };
    calls.push({ entity_type: body.entity_type, ...(body.scope === undefined ? {} : { scope: body.scope }) });

    if (body.entity_type === 'channel') {
      return okJson({
        items: opts.channelItems.map((i) => ({ deleted: false, ...i })),
        next_version: opts.channelItems.length,
        has_more: false,
      });
    }
    if (body.entity_type === 'user' && body.scope !== undefined) {
      const payload = opts.scopedUsers?.[body.scope];
      return okJson({
        items: payload === undefined ? [] : [{ entity_id: body.scope.split(':')[1], version: 9, deleted: false, payload }],
        next_version: 9,
        has_more: false,
      });
    }
    return okJson({ items: [], next_version: 0, has_more: false });
  };
  return { transport: t, calls };
}

const dmChannel = (channelId: string, peerUserId: number) => ({
  entity_id: channelId,
  version: 1,
  payload: {
    channel_id: Number(channelId),
    channel_type: 1,
    channel_name: '',
    peer_user_id: peerUserId,
    unread_count: 1,
    last_msg_content: 'hi',
    last_msg_timestamp: 1_700,
  },
});

/** flush 是 80ms 后的定时任务，等它跑完。 */
const waitForFlush = () => new Promise((r) => setTimeout(r, 250));

describe('unresolved DM peers', () => {
  /// 会话到了、对端 user 没到 —— DM 标题由 UI join `users` 得到，缺了就只能显示
  /// fallback。这里断言 SDK 会**定向**把缺的那个对端补回来。
  it('queues a targeted user sync for a DM whose peer is not cached', async () => {
    const { transport, calls } = scopeRecordingTransport({
      channelItems: [dmChannel('12345', 22)],
      scopedUsers: {
        'user:22': { user_id: 22, username: 'demo', nickname: 'Demo' },
      },
    });
    client = new PrivchatClient({
      transport,
      cache: { enabled: true, db: new CacheDB(uniqueDbName('unresolved-dm')) },
    });
    await client.connect();
    await client.bootstrapChannels();
    await waitForFlush();

    expect(calls).toContainEqual({ entity_type: 'user', scope: 'user:22' });
    expect(client.cachedUser('22')?.nickname).toBe('Demo');
  });

  /// 对端已经在本地就不该再补：每次读会话列表都排一遍，会把一次局部缺失
  /// 放大成持续的无效同步。
  it('does not queue a sync when the peer is already cached', async () => {
    const { transport, calls } = scopeRecordingTransport({
      channelItems: [dmChannel('12345', 22)],
      scopedUsers: {
        'user:22': { user_id: 22, username: 'demo', nickname: 'Demo' },
      },
    });
    client = new PrivchatClient({
      transport,
      cache: { enabled: true, db: new CacheDB(uniqueDbName('unresolved-dm-cached')) },
    });
    await client.connect();
    await client.bootstrapChannels();
    await waitForFlush();
    const before = calls.filter((c) => c.scope === 'user:22').length;
    expect(before).toBeGreaterThan(0);

    // 第二次：user 22 已在缓存里，不应再产生定向同步。
    await client.bootstrapChannels();
    await waitForFlush();
    expect(calls.filter((c) => c.scope === 'user:22').length).toBe(before);
  });

  /// 群会话没有 DM 对端，群名以 group 实体为权威；把它算进来会为每个群
  /// 排一堆无意义的定向 user sync。
  it('ignores group channels', async () => {
    const { transport, calls } = scopeRecordingTransport({
      channelItems: [
        {
          entity_id: '67890',
          version: 1,
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
    });
    client = new PrivchatClient({
      transport,
      cache: { enabled: true, db: new CacheDB(uniqueDbName('unresolved-dm-group')) },
    });
    await client.connect();
    await client.bootstrapChannels();
    await waitForFlush();

    expect(calls.filter((c) => c.entity_type === 'user' && c.scope !== undefined)).toHaveLength(0);
  });
});
