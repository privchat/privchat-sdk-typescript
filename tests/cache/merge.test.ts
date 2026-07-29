import { describe, expect, it } from 'vitest';
import {
  mergeOnPushAbsorb,
  type MessageRecord,
} from '../../src/cache/index.js';

const SELF_UID = 'self-1';
const PEER_UID = 'peer-2';

function rec(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'r-1',
    channel_id: '12345',
    channel_type: 1,
    server_message_id: 's-1',
    from_uid: PEER_UID,
    message_type: 'text',
    content: 'hello',
    payload: new Uint8Array(),
    timestamp: 1_700_000_000_000,
    status: 'received',
    ...overrides,
  };
}

describe('mergeOnPushAbsorb', () => {
  it('returns incoming verbatim when there is no existing row', () => {
    const incoming = rec();
    const result = mergeOnPushAbsorb(undefined, incoming, { currentUserId: SELF_UID });
    expect(result).toBe(incoming);
  });

  it('preserves an acked own-message row when self-push lands with empty content', () => {
    const existing = rec({
      from_uid: SELF_UID,
      content: 'phase14 outbox @ 1234',
      local_message_id: 'L-9',
      status: 'sent',
      pts: '7',
    });
    const incoming = rec({
      from_uid: SELF_UID,
      content: '', // push wire doesn't carry content
      status: 'received',
      pts: '7',
    });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.status).toBe('sent');
    expect(result.content).toBe('phase14 outbox @ 1234');
    expect(result.local_message_id).toBe('L-9');
    expect(result.pts).toBe('7');
  });

  it('absorbs incoming.pts into an acked row that lacked it', () => {
    const existing = rec({
      from_uid: SELF_UID,
      content: 'hi',
      status: 'sent',
      pts: undefined,
    });
    const incoming = rec({ from_uid: SELF_UID, content: '', status: 'received', pts: '42' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.status).toBe('sent');
    expect(result.content).toBe('hi');
    expect(result.pts).toBe('42');
  });

  it('promotes a pending local echo when self-push wins the ACK race', () => {
    const existing = rec({
      server_message_id: undefined,
      local_message_id: 'L-10',
      from_uid: SELF_UID,
      content: '不能变空',
      payload: new TextEncoder().encode('不能变空'),
      status: 'pending',
      pts: undefined,
    });
    const incoming = rec({
      server_message_id: 's-10',
      local_message_id: 'L-10',
      from_uid: SELF_UID,
      content: '',
      payload: new Uint8Array(),
      status: 'received',
      pts: '43',
    });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result).toMatchObject({
      server_message_id: 's-10',
      local_message_id: 'L-10',
      content: '不能变空',
      status: 'sent',
      pts: '43',
    });
    expect(result.payload).toEqual(existing.payload);
  });

  it('promotes revoked from incoming when existing was non-revoked', () => {
    const existing = rec({ from_uid: SELF_UID, status: 'sent', revoked: false });
    const incoming = rec({ from_uid: SELF_UID, content: '', status: 'received', revoked: true });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.revoked).toBe(true);
    expect(result.status).toBe('sent');
  });

  // 原断言是 `toBe(incoming)`（原样返回入参对象）。那条规则正是 2026-07-29 事故的
  // 成因，已改为「命中既有行时合并而非整体替换」。这里保留原本要覆盖的意图——
  // 带正文的远端推送要能把占位内容更新掉——但身份归既有行。
  it('remote push carrying real content updates the body, keeping the row identity', () => {
    const existing = rec({
      id: 'r-existing',
      from_uid: PEER_UID,
      content: 'placeholder',
      status: 'sent', // unusual but tests the branch
    });
    const incoming = rec({ id: 'r-push', from_uid: PEER_UID, content: 'real-content', status: 'received' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.content).toBe('real-content');
    expect(result.id).toBe('r-existing');
  });

  it('a push with a body updates a non-sent row, keeping the row identity', () => {
    const existing = rec({ id: 'r-existing', from_uid: SELF_UID, content: 'old', status: 'received' });
    const incoming = rec({ id: 'r-push', from_uid: SELF_UID, content: 'new', status: 'received' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: SELF_UID });
    expect(result.content).toBe('new');
    expect(result.id).toBe('r-existing');
  });

  // ⚠️ 这条原来的期望是**错的**，它把事故写成了契约：existing 有正文且已 sent，
  // incoming 是空正文的推送，原断言要求取空的那个。认不出当前用户（未认证/刚重连）
  // 时把正文擦掉，正是 web/h5 消息变空白的直接成因。正确性不该依赖认对身份。
  it('does not blank a confirmed row just because the session identity is unknown', () => {
    const existing = rec({ id: 'r-existing', from_uid: SELF_UID, status: 'sent', content: 'old' });
    const incoming = rec({ id: 'r-push', from_uid: SELF_UID, status: 'received', content: '' });
    const result = mergeOnPushAbsorb(existing, incoming, { currentUserId: undefined });
    expect(result.content).toBe('old');
    expect(result.status).toBe('sent');
    expect(result.id).toBe('r-existing');
  });

  // 2026-07-29 生产回归：web/h5 发出的消息几秒后变空白并消失，刷新才回来。
  //
  // 抓到的真实转变（同一 server_message_id）：
  //   +2.5s  content="DX-608874" status=sent     from=自己  id=…795209
  //   +9.5s  content=""          status=received from=对方  id=…780365
  //
  // 顶掉它的是**对方的状态推送**：同一条消息、空 payload、from_uid 是确认方。
  // 旧实现在「不是自己发的」分支直接 return incoming，于是行身份被重铸、正文被擦掉。
  describe('对方发来的状态推送（空 payload，同一 server_message_id）', () => {
    const statusPush = (): MessageRecord =>
      rec({
        id: 'r-fresh-from-push',
        from_uid: PEER_UID,      // 报告状态的是对方，不是消息作者
        content: '',             // 状态推送不带正文——服务端只在首发时送一次
        payload: new Uint8Array(),
        status: 'received',
      });

    it('不得改变行的稳定身份', () => {
      const mine = rec({ id: 'r-mine', from_uid: SELF_UID, content: 'DX-608874', status: 'sent' });
      const out = mergeOnPushAbsorb(mine, statusPush(), { currentUserId: SELF_UID });
      expect(out.id).toBe('r-mine');
    });

    it('不得擦掉已有正文', () => {
      const mine = rec({ id: 'r-mine', from_uid: SELF_UID, content: 'DX-608874', status: 'sent' });
      const out = mergeOnPushAbsorb(mine, statusPush(), { currentUserId: SELF_UID });
      expect(out.content).toBe('DX-608874');
    });

    it('不得把状态从 sent 退回 received', () => {
      const mine = rec({ id: 'r-mine', from_uid: SELF_UID, content: 'DX-608874', status: 'sent' });
      const out = mergeOnPushAbsorb(mine, statusPush(), { currentUserId: SELF_UID });
      expect(out.status).toBe('sent');
    });

    it('不得把作者改成报告状态的那一方', () => {
      const mine = rec({ id: 'r-mine', from_uid: SELF_UID, content: 'DX-608874', status: 'sent' });
      const out = mergeOnPushAbsorb(mine, statusPush(), { currentUserId: SELF_UID });
      expect(out.from_uid).toBe(SELF_UID);
    });

    // 会话未认证时 currentUserId 是 undefined —— 正确性不该依赖认对身份。
    it('即使认不出当前用户，也不得擦掉正文或换身份', () => {
      const mine = rec({ id: 'r-mine', from_uid: SELF_UID, content: 'DX-608874', status: 'sent' });
      const out = mergeOnPushAbsorb(mine, statusPush(), {});
      expect(out.id).toBe('r-mine');
      expect(out.content).toBe('DX-608874');
      expect(out.status).toBe('sent');
    });

    // 收到的别人的消息同样不能被后续状态推送擦白。
    it('对方消息被其状态推送跟随时也保住正文', () => {
      const theirs = rec({ id: 'r-theirs', from_uid: PEER_UID, content: 'Haode', status: 'received' });
      const out = mergeOnPushAbsorb(theirs, statusPush(), { currentUserId: SELF_UID });
      expect(out.id).toBe('r-theirs');
      expect(out.content).toBe('Haode');
    });
  });

  // 真的带正文的推送仍然要能更新行（首发/多端同步那条）。
  it('带正文的推送仍然写入内容，但不改变行身份', () => {
    const local = rec({ id: 'r-local', from_uid: SELF_UID, content: '', status: 'pending' });
    const real = rec({ id: 'r-push', from_uid: SELF_UID, content: '真正的正文',
      payload: new Uint8Array([1, 2, 3]), status: 'received' });
    const out = mergeOnPushAbsorb(local, real, { currentUserId: SELF_UID });
    expect(out.id).toBe('r-local');
    expect(out.status).toBe('sent');
  });
});
