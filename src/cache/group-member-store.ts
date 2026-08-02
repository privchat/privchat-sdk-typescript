// 本地群花名册投影（SDK_ENTITY_MODEL §2.4 + CHANNEL_SPEC §9.2.2）。
//
// App 一直是「读本地 → 后台同步 → 再读本地」；web/h5 此前每次打开成员列表都问服务端要
// 一整份（750 人 = 126 KB）。这个模块把关系行落到 IndexedDB，让两个 web 端也能先渲染
// 再刷新。
//
// 边界：**只存关系字段**。`display_name` 在读取时与 `users` 表聚合（见 `joinDisplayName`），
// spec 明确禁止把它冗余写进关系行——否则用户改一次昵称，就得回头重写他所在每个群的
// 每一行，漏一处就是一个永远显示旧名字的成员。

import type { CacheDB } from './indexeddb-store.js';
import type { GroupMemberRecord, UserRecord } from './types.js';

/** 一行关系 + 读取时聚合出来的展示字段。 */
export interface GroupMemberView extends GroupMemberRecord {
  display_name: string;
  avatar_url?: string;
  user_type: number;
  /** 仅本人可见（PROFILE_VISIBILITY §D1）；非自己一律空串。 */
  username: string;
}

/**
 * 群内展示名优先级，与 SDK_ENTITY_MODEL §1 冻结的一致：
 * `group_member.alias -> user.nickname -> user.username -> user_id`。
 *
 * 空白等同于没有——服务端历史上把空串当「有值」传下来过，渲染出来是个空名字，
 * 比直接显示 uid 更糟，因为它看起来像加载失败。
 */
export function resolveMemberDisplayName(
  alias: string | undefined,
  user: Pick<UserRecord, 'nickname' | 'username'> | undefined,
  userId: string,
): string {
  const pick = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t !== undefined && t !== '' ? t : undefined;
  };
  return pick(alias) ?? pick(user?.nickname) ?? pick(user?.username) ?? userId;
}

/**
 * 写入一页成员。`sync_version` 单调：迟到的旧响应不覆盖新行。
 *
 * 不做「本页之外的都删掉」——一页不是全群，那样会把没在这一页里的人误删。
 * 离群的人由 [`pruneGroupMembers`] 在拿到**全量**时清理。
 */
export async function upsertGroupMembers(
  db: CacheDB,
  rows: readonly GroupMemberRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  const keys = rows.map((r) => [r.group_id, r.user_id] as [string, string]);
  const existing = await db.group_members.bulkGet(keys);
  const next: GroupMemberRecord[] = [];
  rows.forEach((row, i) => {
    const prev = existing[i];
    if (prev === undefined || row.sync_version >= prev.sync_version) next.push(row);
  });
  if (next.length > 0) await db.group_members.bulkPut(next);
}

/**
 * 用一份**全量**花名册收敛本地：不在其中的成员行删掉（有人退群/被移出）。
 * MUST 只在调用方确实拿到了全量时调用——传一页进来会误删其余成员。
 */
export async function pruneGroupMembers(
  db: CacheDB,
  groupId: string,
  keepUserIds: readonly string[],
): Promise<number> {
  const keep = new Set(keepUserIds);
  const local = await db.group_members.where('group_id').equals(groupId).toArray();
  const stale = local.filter((r) => !keep.has(r.user_id));
  if (stale.length === 0) return 0;
  await db.group_members.bulkDelete(
    stale.map((r) => [r.group_id, r.user_id] as [string, string]),
  );
  return stale.length;
}

/** 本地已缓存的成员数（不代表群总人数——那个只有服务端知道）。 */
export async function countGroupMembers(db: CacheDB, groupId: string): Promise<number> {
  return db.group_members.where('group_id').equals(groupId).count();
}

/**
 * 读一页本地成员，按入群时间升序——与服务端同一口径，
 * 所以本地渲染和随后的网络刷新不会互相跳动。
 */
export async function readGroupMemberPage(
  db: CacheDB,
  groupId: string,
  users: ReadonlyMap<string, UserRecord>,
  page?: { limit?: number; offset?: number },
): Promise<GroupMemberView[]> {
  const rows = await db.group_members.where('group_id').equals(groupId).toArray();
  rows.sort((a, b) =>
    a.joined_at !== b.joined_at
      ? a.joined_at - b.joined_at
      : a.user_id.localeCompare(b.user_id),
  );
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? rows.length;
  return rows.slice(offset, offset + limit).map((row) => {
    const user = users.get(row.user_id);
    return {
      ...row,
      display_name: resolveMemberDisplayName(row.alias, user, row.user_id),
      avatar_url: user?.avatar_url,
      user_type: user?.user_type ?? 0,
      // 非自己的 username 服务端根本不下发，本地也不得凭空补出来。
      username: '',
    };
  });
}
