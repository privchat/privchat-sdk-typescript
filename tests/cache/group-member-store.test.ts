import { describe, expect, it } from 'vitest';
import { CacheDB } from '../../src/cache-idb.js';
import 'fake-indexeddb/auto';
import {
  advanceGroupMemberWatermark,
  countGroupMembers,
  groupMemberSyncWatermark,
  numericRoleToString,
  pruneGroupMembers,
  readGroupMemberPage,
  resolveMemberDisplayName,
  upsertGroupMembers,
} from '../../src/cache/group-member-store.js';
import type { GroupMemberRecord, UserRecord } from '../../src/cache/types.js';

let dbSeq = 0;
function newDb(): CacheDB {
  return new CacheDB(`gm-test-${dbSeq++}`);
}

function member(
  userId: string,
  over: Partial<GroupMemberRecord> = {},
): GroupMemberRecord {
  return {
    group_id: '513',
    user_id: userId,
    role: 'member',
    is_muted: false,
    joined_at: Number(userId),
    sync_version: 1,
    cached_at: 1,
    ...over,
  };
}

function user(userId: string, over: Partial<UserRecord> = {}): UserRecord {
  return {
    user_id: userId,
    username: `u${userId}`,
    nickname: `n${userId}`,
    user_type: 0,
    sync_version: 1,
    ...over,
  } as UserRecord;
}

describe('群内展示名优先级（SDK_ENTITY_MODEL §1，冻结）', () => {
  it('alias > nickname > username > uid', () => {
    expect(resolveMemberDisplayName('群名片', user('7'), '7')).toBe('群名片');
    expect(resolveMemberDisplayName(undefined, user('7'), '7')).toBe('n7');
    expect(
      resolveMemberDisplayName(undefined, user('7', { nickname: '' }), '7'),
    ).toBe('u7');
    expect(resolveMemberDisplayName(undefined, undefined, '7')).toBe('7');
  });

  it('空白不算有值', () => {
    // 服务端历史上把空串当「有值」传下来过；渲染出来是个空名字，
    // 看起来像加载失败，比直接显示 uid 更糟。
    expect(resolveMemberDisplayName('   ', user('7'), '7')).toBe('n7');
  });
});

describe('本地花名册投影', () => {
  it('按入群时间升序读一页，与服务端同一口径', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('3'), member('1'), member('2')]);
    const users = new Map([['1', user('1')], ['2', user('2')], ['3', user('3')]]);

    const page = await readGroupMemberPage(db, '513', users, { limit: 2 });
    expect(page.map((m) => m.user_id)).toEqual(['1', '2']);

    const next = await readGroupMemberPage(db, '513', users, {
      limit: 2,
      offset: 2,
    });
    expect(next.map((m) => m.user_id)).toEqual(['3']);
  });

  it('display_name 在读取时聚合，改昵称无需重写成员行', async () => {
    // spec §2.4 禁止把 display_name 冗余进关系表，正是为了这一点。
    const db = newDb();
    await upsertGroupMembers(db, [member('1')]);

    const before = await readGroupMemberPage(db, '513', new Map([['1', user('1')]]));
    expect(before[0]?.display_name).toBe('n1');

    const after = await readGroupMemberPage(
      db,
      '513',
      new Map([['1', user('1', { nickname: '改名了' })]]),
    );
    expect(after[0]?.display_name).toBe('改名了');
  });

  it('旧响应不覆盖新行', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('1', { role: 'owner', sync_version: 5 })]);
    // 迟到的旧响应（版本更小）：必须被丢弃，否则群主会被降级成普通成员。
    await upsertGroupMembers(db, [member('1', { role: 'member', sync_version: 2 })]);

    const rows = await readGroupMemberPage(db, '513', new Map());
    expect(rows[0]?.role).toBe('owner');
  });

  it('写一页不会删掉这一页之外的成员', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('1'), member('2'), member('3')]);
    await upsertGroupMembers(db, [member('1')]); // 只写第一页
    expect(await countGroupMembers(db, '513')).toBe(3);
  });

  it('拿到全量时才清理退群的人', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('1'), member('2'), member('3')]);
    const removed = await pruneGroupMembers(db, '513', ['1', '3']);
    expect(removed).toBe(1);
    expect(await countGroupMembers(db, '513')).toBe(2);
  });

  it('不串群：清理只影响目标群', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [
      member('1'),
      member('2', { group_id: '999', joined_at: 2 }),
    ]);
    await pruneGroupMembers(db, '513', []);
    expect(await countGroupMembers(db, '513')).toBe(0);
    expect(await countGroupMembers(db, '999')).toBe(1);
  });

  it('本地没有 user 行时退化成 uid，而不是空名字', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('42')]);
    const rows = await readGroupMemberPage(db, '513', new Map());
    expect(rows[0]?.display_name).toBe('42');
  });
});

describe('增量同步水位', () => {
  it('只认服务端量纲的版本，未知（0）不参与', async () => {
    // 这条是为一个真实设计错误立的：`sync_version` 一度填的是 `Date.now()`，
    // 水位会瞬间跳到服务端永远追不上的数——增量同步从此认为自己同步完了，
    // 再也拉不到任何成员变更。
    const db = newDb();
    await upsertGroupMembers(db, [
      member('1', { sync_version: 0, cached_at: Date.now() }), // 来自 member/list
      member('2', { sync_version: 37 }), // 来自实体同步
    ]);
    expect(await groupMemberSyncWatermark(db, '513')).toBe(37);
  });

  it('全是未知版本时水位是 0，即从头同步', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('1', { sync_version: 0 })]);
    expect(await groupMemberSyncWatermark(db, '513')).toBe(0);
  });

  it('带版本的行压过未知版本的行', async () => {
    // 否则一次 member/list 刷新会把增量同步刚拿到的新角色覆盖回旧值。
    const db = newDb();
    await upsertGroupMembers(db, [
      member('1', { role: 'owner', sync_version: 9, cached_at: 1 }),
    ]);
    await upsertGroupMembers(db, [
      member('1', { role: 'member', sync_version: 0, cached_at: Date.now() }),
    ]);
    const rows = await readGroupMemberPage(db, '513', new Map());
    expect(rows[0]?.role).toBe('owner');
  });
});

describe('role 编码收敛', () => {
  it('实体同步的数值与 member/list 的字符串收敛到同一个小写契约', () => {
    // 编号是协议冻结的 Member=0 / Owner=1 / Admin=2。
    // 两条路进来的同一个人必须得到同一个 role，否则权限判定取决于
    // 你先走了哪条路。
    expect(numericRoleToString(0)).toBe('member');
    expect(numericRoleToString(1)).toBe('owner');
    expect(numericRoleToString(2)).toBe('admin');
    expect(numericRoleToString('Owner')).toBe('owner');
  });

  it('0 与未知一律是权限最低的成员', () => {
    // 字段缺失、默认值、老版本不认识的取值都会落在这里。
    // 往上猜是提权：解析不出来的角色绝不能变成群主。
    expect(numericRoleToString(undefined)).toBe('member');
    expect(numericRoleToString(99)).toBe('member');
    expect(numericRoleToString(null)).toBe('member');
    expect(numericRoleToString('god')).toBe('god'.toLowerCase());
  });
});

describe('tombstone 与水位', () => {
  it('水位显式持久化，删掉的行不会把它拖回去', async () => {
    // 生产实测：靠 max(row.sync_version) 当水位时，退群成员的 tombstone
    // 每次同步都重下发一遍——第 2、3、4 次全是同样的 2 条，永远追不平。
    const db = newDb();
    await upsertGroupMembers(db, [member('1', { sync_version: 10 })]);
    await advanceGroupMemberWatermark(db, '513', 42); // 第 42 版是一条 tombstone
    await db.group_members.bulkDelete([['513', '1']]); // tombstone 应用：行没了

    expect(await countGroupMembers(db, '513')).toBe(0);
    expect(await groupMemberSyncWatermark(db, '513')).toBe(42);
  });

  it('水位只增不减', async () => {
    const db = newDb();
    await advanceGroupMemberWatermark(db, '513', 42);
    await advanceGroupMemberWatermark(db, '513', 7); // 迟到的旧响应
    expect(await groupMemberSyncWatermark(db, '513')).toBe(42);
  });

  it('没记录过水位时回退到行里的最大版本，省一整轮全量', async () => {
    const db = newDb();
    await upsertGroupMembers(db, [member('1', { sync_version: 88 })]);
    expect(await groupMemberSyncWatermark(db, '513')).toBe(88);
  });

  it('水位按群隔离', async () => {
    const db = newDb();
    await advanceGroupMemberWatermark(db, '513', 42);
    expect(await groupMemberSyncWatermark(db, '999')).toBe(0);
  });
});
