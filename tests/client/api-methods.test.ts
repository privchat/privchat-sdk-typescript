// Spot-check coverage of the prototype-augmented RPC sugar. Verifies
// route + body for one example per category; the bodies all go through
// the same `rpcCallTyped` path so per-method body validation is overkill.

import { describe, expect, it } from 'vitest';
import {
  decodeRpcRequest,
  encodeRpcResponse,
  PrivchatClient,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

const ok = (data: unknown) =>
  encodeRpcResponse({
    code: 0,
    message: 'ok',
    data: new TextEncoder().encode(JSON.stringify(data)),
  });

const captureRpc = () => {
  const t = new FakeTransport();
  let route = '';
  let body: unknown = null;
  let rawBody = '';
  t.responder = (pkt) => {
    const decoded = decodeRpcRequest(pkt.payload);
    route = decoded.route;
    rawBody = new TextDecoder().decode(decoded.body);
    body = JSON.parse(rawBody);
    return ok(true);
  };
  return { t, get: () => ({ route, body, rawBody }) };
};

describe('account', () => {
  it('accountSearch hits account/search/query with from_user_id=0', async () => {
    const cap = captureRpc();
    cap.t.responder = (pkt) => {
      const r = decodeRpcRequest(pkt.payload);
      expect(r.route).toBe('account/search/query');
      expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({
        query: 'alice',
        page: 1,
        page_size: 20,
        from_user_id: 0,
      });
      return ok({ users: [], total: 0, query: 'alice' });
    };
    const c = new PrivchatClient({ transport: cap.t });
    await c.accountSearch('alice');
  });
});

describe('friend', () => {
  it('friendApply', async () => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await c.friendApply(42, 'hi', 'friend', '42');
    expect(cap.get().route).toBe('contact/friend/apply');
    expect(cap.get().body).toEqual({
      target_user_id: 42,
      message: 'hi',
      source: 'friend',
      source_id: '42',
      from_user_id: 0,
    });
  });

  it('friendAccept returns bare u64 channel_id', async () => {
    const t = new FakeTransport();
    t.responder = () => ok(900710001);
    const c = new PrivchatClient({ transport: t });
    const id = await c.friendAccept(42, 'ok');
    expect(id).toBe(900710001);
  });

  it('friendCheck / friendPending / friendRemove / friendSetAlias hit correct routes', async () => {
    for (const [fn, expectedRoute] of [
      [(c: PrivchatClient) => c.friendCheck(1), 'contact/friend/check'],
      [(c: PrivchatClient) => c.friendPending(), 'contact/friend/pending'],
      [(c: PrivchatClient) => c.friendRemove(1), 'contact/friend/remove'],
      [(c: PrivchatClient) => c.friendSetAlias(1, 'alice'), 'contact/friend/set_alias'],
    ] as const) {
      const cap = captureRpc();
      const c = new PrivchatClient({ transport: cap.t });
      await fn(c);
      expect(cap.get().route).toBe(expectedRoute);
    }
  });
});

describe('blacklist', () => {
  it('blacklistAdd / Remove / List / Check carry caller user_id', async () => {
    for (const [fn, expectedRoute, expectedBody] of [
      [
        (c: PrivchatClient) => c.blacklistAdd(11, 22),
        'contact/blacklist/add',
        { user_id: 11, blocked_user_id: 22 },
      ],
      [
        (c: PrivchatClient) => c.blacklistRemove(11, 22),
        'contact/blacklist/remove',
        { user_id: 11, blocked_user_id: 22 },
      ],
      [
        (c: PrivchatClient) => c.blacklistList(11),
        'contact/blacklist/list',
        { user_id: 11 },
      ],
      [
        (c: PrivchatClient) => c.blacklistCheck(11, 22),
        'contact/blacklist/check',
        { user_id: 11, target_user_id: 22 },
      ],
    ] as const) {
      const cap = captureRpc();
      const c = new PrivchatClient({ transport: cap.t });
      await fn(c);
      expect(cap.get().route).toBe(expectedRoute);
      expect(cap.get().body).toEqual(expectedBody);
    }
  });
});

describe('channel', () => {
  it.each([
    [(c: PrivchatClient) => c.channelDirectGetOrCreate(1), 'channel/direct/get_or_create'],
    [(c: PrivchatClient) => c.channelPin(1, true), 'channel/pin'],
    [(c: PrivchatClient) => c.channelHide(1), 'channel/hide'],
    [(c: PrivchatClient) => c.channelMute(1, true), 'channel/mute'],
  ] as const)('hits %#', async (fn, expectedRoute) => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await fn(c);
    expect(cap.get().route).toBe(expectedRoute);
  });

  it('channelPin preserves a snowflake channel id above 2^53', async () => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await c.channelPin('9007199254740993', true);
    expect(cap.get().rawBody).toContain('"channel_id":9007199254740993');
  });
});

describe('group', () => {
  it.each([
    [(c: PrivchatClient) => c.groupCreate('test'), 'group/group/create'],
    [(c: PrivchatClient) => c.groupInfo(1), 'group/group/info'],
    [(c: PrivchatClient) => c.groupMemberAdd(1, 2), 'group/member/add'],
    [(c: PrivchatClient) => c.groupMemberList(1), 'group/member/list'],
    [(c: PrivchatClient) => c.groupMemberLeave(1), 'group/member/leave'],
    [
      (c: PrivchatClient) => c.groupRoleSet(1, 100, 200, 'admin'),
      'group/role/set',
    ],
    [
      (c: PrivchatClient) => c.groupTransferOwner(1, 100, 200),
      'group/role/transfer_owner',
    ],
    [(c: PrivchatClient) => c.groupSettingsGet(1), 'group/settings/get'],
    [
      (c: PrivchatClient) =>
        c.groupSettingsUpdate(1, 100, { description: 'x' }),
      'group/settings/update',
    ],
    [
      (c: PrivchatClient) => c.groupMuteAll(1, 100, true),
      'group/settings/mute_all',
    ],
  ] as const)('hits %#', async (fn, expectedRoute) => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await fn(c);
    expect(cap.get().route).toBe(expectedRoute);
  });
});

describe('message', () => {
  it.each([
    [(c: PrivchatClient) => c.messageHistory(1), 'message/history/get'],
    [(c: PrivchatClient) => c.messageRevoke(1, 2), 'message/revoke'],
    [(c: PrivchatClient) => c.messageReactionAdd(1, '👍'), 'message/reaction/add'],
    [(c: PrivchatClient) => c.messageReactionRemove(1, '👍'), 'message/reaction/remove'],
    [(c: PrivchatClient) => c.messageReactionList(1), 'message/reaction/list'],
  ] as const)('hits %#', async (fn, expectedRoute) => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await fn(c);
    expect(cap.get().route).toBe(expectedRoute);
  });

  it('messageHistory preserves channel and cursor snowflakes above 2^53', async () => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await c.messageHistory('9007199254740993', 50, '9007199254740995');
    expect(cap.get().rawBody).toContain('"channel_id":9007199254740993');
    expect(cap.get().rawBody).toContain(
      '"before_server_message_id":9007199254740995',
    );
  });
});

describe('presence', () => {
  it.each([
    [(c: PrivchatClient) => c.sendTyping(1, true), 'presence/typing'],
    [(c: PrivchatClient) => c.batchGetPresence([1, 2, 3]), 'presence/status/get'],
  ] as const)('hits %#', async (fn, expectedRoute) => {
    const cap = captureRpc();
    const c = new PrivchatClient({ transport: cap.t });
    await fn(c);
    expect(cap.get().route).toBe(expectedRoute);
  });
});
