// 会话预览的归属，必须有自己的证据，不能靠「现在是不是空的」。
//
// 生产现象：web 上发出一条文本，气泡不出现，会话列表预览却变成 [系统消息]。服务端
// 那三条都是 message_type=0(text)，所以坏的是本地投影。
//
// 机制：频道先经 sync 拿到 latest_pts 与一条（错误的）非空预览，随后同一条消息以
// **相同 pts** 由 push 重放。旧判据三条全不成立——becomesLatest 要求 pts 更大、
// timestampAdvanced 要求时间更晚、previewMissing 要求当前为空——于是错误预览被永久
// 固定下来，重开也不会好。
//
// 修法不是「等 pts 一律覆盖」：那会让旧的重复投递盖掉更新的预览。预览要记住自己
// 来自哪条消息（last_message_pts），然后按 pts 比较。

import { afterEach, describe, expect, it } from 'vitest';
import { Packet, PacketType } from '@msgtrans/client';
import {
  MessageType,
  PrivchatClient,
  encodeAuthorizationResponse,
  encodePushMessageRequest,
  decodeRpcRequest,
  encodeRpcResponse,
} from '../../src/index.js';
import { CacheDB, ensureCacheOwner, upsertChannels } from '../../src/cache/index.js';
import { FakeTransport } from './fake-transport.js';

let client: PrivchatClient | null = null;
let dbCounter = 0;

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

const CHANNEL_ID = '45';
const SERVER_MESSAGE_ID = '604863813275090944';
const PTS = '24';
const SENT_AT_SECONDS = 1_785_190_370; // push.timestamp 是秒
const SENT_AT_MS = SENT_AT_SECONDS * 1000;

function transport(): FakeTransport {
  const t = new FakeTransport();
  t.responder = (pkt) => {
    if (pkt.bizType === 1) return encodeAuthorizationResponse({ success: true });
    if (pkt.bizType === 17) {
      decodeRpcRequest(pkt.payload);
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

describe('conversation preview ownership', () => {
  it('an equal-pts text push corrects a stale system preview', async () => {
    const dbName = `stale-preview-${++dbCounter}`;

    // 频道已被 sync 推到 pts=24，并且带着一条**错误的**非空预览。
    const seed = new CacheDB(dbName);
    // 缓存所有者：没有它这个库会被当成来路不明并整个清空（账号隔离守卫）。
    await ensureCacheOwner(seed, '100000028');
    await upsertChannels(seed, [
      {
        channel_id: CHANNEL_ID,
        channel_type: 1,
        title: 'peer',
        latest_pts: PTS,
        read_pts: '0',
        unread_count: 0,
        last_message_preview: '旧系统消息',
        last_message_type: 'system',
        updated_at: SENT_AT_MS,
        sync_version: 1,
      },
    ]);
    seed.close();

    const t = transport();
    client = new PrivchatClient({ transport: t, cache: { enabled: true, dbName } });
    await client.connect();
    await client.authenticate('100000028', 'tok', 'dev');
    // 把持久化的频道读进内存 store（RPC 这边返回空，频道来自本地缓存）。
    await client.bootstrapChannels();

    // 同一条消息由 push 重放：pts 相同、时间相同。
    const pushBytes = encodePushMessageRequest({
      setting: { need_receipt: false, signal: 0 },
      server_message_id: SERVER_MESSAGE_ID,
      local_message_id: '0',
      message_seq: Number(PTS),
      from_uid: '100000028',
      channel_id: CHANNEL_ID,
      channel_type: 1,
      timestamp: SENT_AT_SECONDS,
      topic: '',
      stream_no: '',
      stream_seq: 0,
      stream_flag: 0,
      expire: 0,
      message_type: 0,
      msg_key: '',
      payload: new TextEncoder().encode(JSON.stringify({ content: '1', metadata: {} })),
      deleted: false,
    });
    t.fireMessage(
      new Packet({ packetType: PacketType.OneWay, messageId: 0, bizType: MessageType.PushMessageRequest, payload: pushBytes }),
    );

    await new Promise((r) => setTimeout(r, 400));

    const channel = client.cachedChannels().find((c) => c.channel_id === CHANNEL_ID);
    // 预览必须被这条 canonical 消息纠正——它就是 pts=24 那条本身。
    expect(channel?.last_message_type).toBe('text');
    expect(channel?.last_message_preview).toBe('1');

    // 而且消息行本身也必须在，不能只更新频道不落消息：生产上正是「预览变了、
    // 气泡没出现」。
    const db = new CacheDB(dbName);
    const rows = await db.messages_v2
      .where('server_message_id')
      .equals(SERVER_MESSAGE_ID)
      .toArray();
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('1');

    // 内存 timeline 也要看得见。生产现象是「预览变了、气泡没出现」，只断言
    // 频道会漏掉一半。
    const timeline = client.getCachedMessages(CHANNEL_ID, 1);
    expect(timeline.some((m) => m.server_message_id === SERVER_MESSAGE_ID)).toBe(true);

    // 刷新后仍然是纠正过的值：修好的必须落盘,不能只活在内存里——否则用户一刷新
    // [系统消息] 就回来了。
    await client.disconnect();
    client = null;
    const reopened = new CacheDB(dbName);
    const persisted = await reopened.channels.get(CHANNEL_ID);
    reopened.close();
    expect(persisted?.last_message_type).toBe('text');
    expect(persisted?.last_message_preview).toBe('1');
    // 归属键也要落盘,否则下一次同 pts 重放又回到「没有证据」的分支。
    expect(persisted?.last_message_pts).toBe(PTS);
  });
});
