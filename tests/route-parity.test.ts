// 每条 RPC 方法都必须打到**协议里那条**路由，且请求字段名与服务端一致。
//
// 这批方法是补齐与原生 SDK 的差距时加的：服务端早就注册了这些路由，只有 TS 侧
// 没接，于是 Web/H5 做不了拒绝好友申请、改资料这些基本操作。路由名或字段名写错
// 不会有编译错误——服务端只会回一个 route not found 或参数错误，所以在这里钉死。

import { describe, it, expect } from 'vitest';
import { Routes } from '../src/routes.js';
import { PrivchatClient } from '../src/client.js';
import '../src/api-methods.js'; // 方法在模块加载时挂到 prototype 上

function makeStub() {
  const calls: Array<{ route: string; body: unknown }> = [];
  // 不构造真 client：只借它的原型，把 rpcCallTyped 换成记录器。
  const proto = Object.create(PrivchatClient.prototype) as PrivchatClient;
  (proto as unknown as { rpcCallTyped: (r: string, b: unknown) => Promise<unknown> })
    .rpcCallTyped = (route, body) => {
    calls.push({ route, body });
    return Promise.resolve({});
  };
  return { proto, calls };
}

describe('新增路由与协议一致', () => {
  it('路由常量与 privchat-protocol 逐字相同', () => {
    expect(Routes.friend.REJECT).toBe('contact/friend/reject');
    expect(Routes.friend.RECALL).toBe('contact/friend/recall');
    expect(Routes.message_status.COUNT).toBe('message/status/count');
    expect(Routes.message_status.READ_LIST).toBe('message/status/read_list');
    expect(Routes.message_status.READ_STATS).toBe('message/status/read_stats');
    expect(Routes.message_reaction.STATS).toBe('message/reaction/stats');
    expect(Routes.account_profile.GET).toBe('account/profile/get');
    expect(Routes.account_profile.UPDATE).toBe('account/profile/update');
    expect(Routes.account_user.UPDATE).toBe('account/user/update');
    expect(Routes.account_user.SHARE_CARD).toBe('account/user/share_card');
    expect(Routes.account_search.BY_QRCODE).toBe('account/search/by_qrcode');
    expect(Routes.qrcode.GENERATE).toBe('qrcode/generate');
    expect(Routes.qrcode.RESOLVE).toBe('qrcode/resolve');
    expect(Routes.qrcode.REFRESH).toBe('qrcode/refresh');
    expect(Routes.qrcode.REVOKE).toBe('qrcode/revoke');
    expect(Routes.qrcode.LIST).toBe('qrcode/list');
    expect(Routes.sticker_package.LIST).toBe('sticker/package/list');
    expect(Routes.sticker_package.DETAIL).toBe('sticker/package/detail');
  });

  it('二维码与表情包的请求体字段名与 handler 读的键一致', async () => {
    const { proto, calls } = makeStub();
    await proto.qrcodeRevoke('k1');
    await proto.stickerPackageDetail('pkg-1');
    expect(calls[0]).toEqual({ route: 'qrcode/revoke', body: { qr_key: 'k1' } });
    expect(calls[1]).toEqual({
      route: 'sticker/package/detail',
      body: { package_id: 'pkg-1' },
    });
  });

  it('请求体字段名走 snake_case，与服务端结构对齐', async () => {
    const { proto, calls } = makeStub();
    await proto.friendReject(1, 2, 'no thanks');
    await proto.friendRecall(2, 1);
    await proto.messageReadList(10, 20);
    await proto.messageReactionStats(30, 40);

    expect(calls[0]).toEqual({
      route: 'contact/friend/reject',
      body: { from_user_id: 1, target_user_id: 2, message: 'no thanks' },
    });
    expect(calls[1]).toEqual({
      route: 'contact/friend/recall',
      body: { target_user_id: 2, from_user_id: 1 },
    });
    expect(calls[2]).toEqual({
      route: 'message/status/read_list',
      body: { message_id: 10, channel_id: 20 },
    });
    expect(calls[3]).toEqual({
      route: 'message/reaction/stats',
      body: { server_message_id: 30, user_id: 40 },
    });
  });

  it('未读计数不传 channelId 时也要发出请求（= 全部会话）', async () => {
    const { proto, calls } = makeStub();
    await proto.messageStatusCount();
    expect(calls[0]).toEqual({
      route: 'message/status/count',
      body: { channel_id: undefined },
    });
  });
});
