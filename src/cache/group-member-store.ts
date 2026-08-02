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

/**
 * 服务端实体同步下发的是 **DB 数值编码**的 role（0=Owner / 1=Admin / 2=Member），
 * 而 `group/member/list` 下发的是小写字符串。两条路必须收敛到同一个小写契约，
 * 否则同一个人从两条路进来会得到两种 role，权限判定看你先走了哪条。
 */
export function numericRoleToString(role: unknown): string {
  if (typeof role === 'string') return role.toLowerCase();
  switch (role) {
    case 0:
      return 'owner';
    case 1:
      return 'admin';
    default:
      return 'member';
  }
}

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
 * 谁更新：**先比服务端版本**，两边都未知（0）时才比本地写入时刻。
 *
 * 带真实版本的行永远压过「不知道是什么时候的」那一行——否则一次
 * `group/member/list` 刷新会把增量同步刚拿到的新状态覆盖回旧值。
 */
function isNewer(next: GroupMemberRecord, prev: GroupMemberRecord): boolean {
  if (next.sync_version !== prev.sync_version) return next.sync_version > prev.sync_version;
  return next.cached_at >= prev.cached_at;
}

function watermarkKey(groupId: string): string {
  return `group_member_watermark:${groupId}`;
}

/**
 * 本群增量同步的水位。
 *
 * **必须显式持久化，不能从存下来的行推**：退群成员是以 tombstone 下发的，
 * 客户端据此把行删掉——那一行的版本号也就跟着没了。靠 `max(row.sync_version)`
 * 当水位，会让这批 tombstone 每次都重新下发一遍，永远追不平（实测生产上
 * 每次同步固定重放 2 条，第 2、3、4 次都一样）。
 *
 * 没有记录过水位时回退到行里的最大版本——那是给「本地已有数据、但还没跑过
 * 增量同步」的缓存用的，比从 0 重来省一整轮。
 */
export async function groupMemberSyncWatermark(
  db: CacheDB,
  groupId: string,
): Promise<number> {
  // cache_metadata 的 value 是字符串（既有表结构），这里按十进制存取。
  const saved = await db.cache_metadata.get(watermarkKey(groupId));
  const savedValue = Number.parseInt(saved?.value ?? '', 10);
  if (Number.isFinite(savedValue) && savedValue > 0) return savedValue;
  const rows = await db.group_members.where('group_id').equals(groupId).toArray();
  return rows.reduce((max, r) => (r.sync_version > max ? r.sync_version : max), 0);
}

/** 推进水位。只增不减——迟到的响应不得把水位拖回去。 */
export async function advanceGroupMemberWatermark(
  db: CacheDB,
  groupId: string,
  version: number,
): Promise<void> {
  const current = await groupMemberSyncWatermark(db, groupId);
  if (version <= current) return;
  await db.cache_metadata.put({ key: watermarkKey(groupId), value: String(version) });
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
    if (prev === undefined || isNewer(row, prev)) next.push(row);
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
