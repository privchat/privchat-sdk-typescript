// 服务端来的一条消息，规范化之后的样子。
//
// 四条**投影**来源——realtime push、`sync/get_difference` commit、
// `message/history/get`、`message/history/around`——的 transport 形态本来就不一样：
// 字段名不同、
// 时间单位不同（push 是秒，其余是毫秒）、metadata 有的在 envelope 里有的在顶层。
// 以前每条来源各自拼一份缓存投影，于是「同一条消息从哪条路进来」决定了它在本地长
// 什么样。两个线上事故就是这么来的：history 进来的图片没有 metadata（缩略图永远
// 下不来），push 进来的时间少了三个数量级（新消息排到会话最前）。
//
// 规则：**来源只做适配，不做投影**。
//
// send ACK 不在其列，这是有意的：它不构造消息行，只在已有乐观行上补服务端身份与
// 顺序（applyAck 拿到的就是调用方补好字段的同一行）。给它硬造一个 adapter 只会多
// 一个没有生产调用者的函数，和一条测得很好看却不存在的路径。
//
//   push / sync commit / history / around
//                    ↓  (各自的 from* 适配器)
//            CanonicalInboundMessage
//                    ↓  (唯一一条投影)
//                MessageRecord
//
// 这份文件与 Rust 侧 `crates/privchat-sdk/src/canonical_inbound.rs` 一一对应，
// 并共读同一份 fixture（privchat-docs/fixtures/canonical-inbound.json）。

/** 10^11 毫秒 = 1973 年。真毫秒必在其上，真秒必在其下。
 *
 *  这个判据存在是因为 wire 上两种单位都有：`PushMessageRequest.timestamp` 是 u32
 *  秒（u32 装不下毫秒纪元，是类型级事实），history/sync 是毫秒。秒值当毫秒用会落到
 *  1970，于是「刚收到的消息」比整个会话都旧。 */
const MIN_PLAUSIBLE_MS = 100_000_000_000;

/** 把任意来源的时间戳归一到毫秒。 */
export function normalizeSentAtMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= MIN_PLAUSIBLE_MS ? value : value * 1000;
}

/**
 * 合并同一条消息（同一 server_message_id）的发送时间。
 *
 * 一条消息的发送时间在服务端是不变量，所以这里唯一合法的分歧来源是**精度**：
 * push 只能给到秒，history/sync 给毫秒。规则据此而定，不看数值大小：
 *
 * - 高精度覆盖低精度；
 * - 低精度**永不**覆盖高精度；
 * - 同精度但值不同 = 某一端的数据坏了。普通 replay 不覆盖（保留先到的），
 *   返回 `conflict` 让调用方打点；要改只能走显式的定向 repair。
 *
 * 之前那版规则是「同秒取 max，跨秒 incoming 覆盖」——跨秒那半条等于让最后到达的
 * 路径赢，而「最后到达」恰恰是最没有权威性的一个属性。
 */
export function mergeSentAt(
  existing: { ms: number; precision: TimePrecision } | undefined,
  incoming: { ms: number; precision: TimePrecision },
): { ms: number; precision: TimePrecision; conflict: boolean } {
  if (existing === undefined || existing.ms <= 0) {
    return { ...incoming, conflict: false };
  }
  if (existing.precision === incoming.precision) {
    return {
      ms: existing.ms,
      precision: existing.precision,
      conflict: existing.ms !== incoming.ms,
    };
  }
  const preciseIsIncoming = incoming.precision === 'milliseconds';
  return {
    ms: preciseIsIncoming ? incoming.ms : existing.ms,
    precision: preciseIsIncoming ? incoming.precision : existing.precision,
    conflict: false,
  };
}

/** 时间戳精度。wire 上两种都有，合并时必须知道手里这个是哪种。 */
export type TimePrecision = 'seconds' | 'milliseconds';

/** 一条服务端消息的规范形态。 */
export interface CanonicalInboundMessage {
  server_message_id: string;
  /** 发送命令的幂等键；缺省表示这条不是本机发出的。 */
  local_message_id?: string;
  channel_id: string;
  channel_type: number;
  from_uid: string;
  /** canonical word form（'text' / 'image' / …），与 Rust 的判别值一一对应。 */
  message_type: string;
  content: string;
  /** 结构化 metadata。`undefined` 只允许表示「服务端确实没给」，不允许表示
   *  「这条路径忘了带」——这个区别就是图片能不能加载的区别。 */
  metadata?: Record<string, unknown>;
  pts: string;
  /** 发送时间，**毫秒**。适配器负责归一，读取方不再猜。 */
  sent_at_ms: number;
  /** 这个时间戳原本的精度。push 只能给到秒，合并时据此决定谁覆盖谁——
   *  丢掉这个信息就只能靠「值看起来像不像整秒」去猜，那是猜不准的
   *  （真实发送时间正好落在整秒上完全可能）。 */
  sent_at_precision: TimePrecision;
  revoked: boolean;
  /** 引用的原消息 server_message_id。 */
  reply_to_message_id?: string;
  /** @ 提及的用户。 */
  mentioned_user_ids?: string[];
  /** 消息来源标记（转发等）。 */
  message_source?: unknown;
  /** 原始/重建的 payload 字节。媒体消息靠它解 metadata。 */
  payload: Uint8Array;
}

/**
 * 跨路径比较用的语义投影。
 *
 * 只包含「同一条消息不论从哪条路进来都必须相同」的字段。刻意排除：本地 `id`、
 * `status`、`local_message_id`、原始 payload bytes、本地媒体路径与下载状态。把这些
 * 一起比会得到一个永远红的测试，然后被人删掉。
 */
export interface SemanticProjection {
  server_message_id: string;
  channel_id: string;
  channel_type: number;
  from_uid: string;
  message_type: string;
  content: string;
  metadata: Record<string, unknown> | null;
  pts: string;
  sent_at_ms: number;
  revoked: boolean;
}

export function semanticProjection(m: CanonicalInboundMessage): SemanticProjection {
  return {
    server_message_id: m.server_message_id,
    channel_id: m.channel_id,
    channel_type: m.channel_type,
    from_uid: m.from_uid,
    message_type: m.message_type,
    content: m.content,
    metadata: m.metadata ?? null,
    pts: m.pts,
    sent_at_ms: m.sent_at_ms,
    revoked: m.revoked,
  };
}

/**
 * 两条来源是否描述了同一条消息。
 *
 * 除 `sent_at_ms` 外全部严格相等；`sent_at_ms` 只要求**落在同一秒**——
 * `PushMessageRequest.timestamp` 是 u32 秒，结构上就给不出毫秒，要求逐字段相等只会
 * 得到一个永远红的门禁。真正要卡的是「同一条消息在不同来源上指向同一个时刻」。
 */
export function agreesWith(a: SemanticProjection, b: SemanticProjection): boolean {
  return (
    a.server_message_id === b.server_message_id &&
    a.channel_id === b.channel_id &&
    a.channel_type === b.channel_type &&
    a.from_uid === b.from_uid &&
    a.message_type === b.message_type &&
    a.content === b.content &&
    JSON.stringify(sortedKeys(a.metadata)) === JSON.stringify(sortedKeys(b.metadata)) &&
    a.pts === b.pts &&
    a.revoked === b.revoked &&
    Math.floor(a.sent_at_ms / 1000) === Math.floor(b.sent_at_ms / 1000)
  );
}

/** 键序无关的 metadata 比较：两端 JSON 序列化顺序不保证一致。 */
function sortedKeys(value: Record<string, unknown> | null): unknown {
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, (value as Record<string, unknown>)[k]]),
  );
}

/** `extra`/envelope JSON 里的 metadata 子对象；取不出就是 undefined。 */
export function metadataFromEnvelope(extra: string | undefined): Record<string, unknown> | undefined {
  if (extra === undefined || extra.length === 0) return undefined;
  try {
    const parsed = JSON.parse(extra) as Record<string, unknown>;
    const metadata = parsed?.metadata;
    if (metadata !== null && typeof metadata === 'object') {
      return metadata as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ----- 来源适配器：wire → canonical。生产代码与门禁测试共用这些函数。 -----
//
// 每条来源只允许在这里出现一次。测试里再实现一遍等于测试自己跟自己比——上一版
// 就是这么"全绿"的，而生产 mapper 一行没改。

import type { HistoricalMessage } from '../api-types.js';
import type { PushMessageRequest } from '../codec/push.js';
import { normalizeMessageDisplayContent } from '../message-content.js';

/** legacy envelope（`{content, metadata, reply_to_message_id, …}`）解析结果。 */
export interface LegacyEnvelope {
  metadata?: Record<string, unknown>;
  reply_to_message_id?: string;
  mentioned_user_ids?: string[];
  message_source?: unknown;
}

/** 重建与 realtime push 同形的 payload envelope。
 *
 *  历史消息的媒体 metadata 必须进 payload，否则 Web VM 无从解码——历史图片会退化成
 *  `[图片]`，缩略图/尺寸/文件名全丢。 */
export function buildEnvelopePayload(
  content: string,
  parts: LegacyEnvelope,
): Uint8Array {
  const hasData =
    (parts.metadata !== undefined && parts.metadata !== null) ||
    parts.reply_to_message_id !== undefined ||
    Array.isArray(parts.mentioned_user_ids) ||
    parts.message_source !== undefined;
  if (!hasData) return new Uint8Array();
  return new TextEncoder().encode(
    JSON.stringify({
      content,
      ...(parts.metadata !== undefined ? { metadata: parts.metadata } : {}),
      ...(parts.reply_to_message_id !== undefined
        ? { reply_to_message_id: parts.reply_to_message_id }
        : {}),
      ...(Array.isArray(parts.mentioned_user_ids)
        ? { mentioned_user_ids: parts.mentioned_user_ids }
        : {}),
      ...(parts.message_source !== undefined ? { message_source: parts.message_source } : {}),
    }),
  );
}

/** `message/history/get` 与 `message/history/around`（同一个 server JSON 视图）。 */
export function canonicalFromHistory(
  msg: HistoricalMessage,
  channel_id: string,
  channel_type: number,
  legacy?: LegacyEnvelope,
): CanonicalInboundMessage {
  const content = normalizeMessageDisplayContent(msg.content);
  const metadata = (msg.metadata as Record<string, unknown> | undefined) ?? legacy?.metadata;
  const reply_to_message_id =
    msg.reply_to_message_id !== undefined
      ? String(msg.reply_to_message_id)
      : legacy?.reply_to_message_id;
  const parts: LegacyEnvelope = {
    metadata,
    reply_to_message_id,
    mentioned_user_ids: legacy?.mentioned_user_ids,
    message_source: legacy?.message_source,
  };
  return {
    server_message_id: String(msg.message_id),
    channel_id,
    channel_type,
    from_uid: String(msg.sender_id),
    message_type: msg.message_type,
    content,
    metadata,
    pts: msg.message_seq !== undefined ? String(msg.message_seq) : '',
    // server 侧是 created_at.timestamp_millis()。
    sent_at_ms: normalizeSentAtMs(msg.timestamp),
    sent_at_precision: 'milliseconds',
    revoked: msg.revoked === true,
    reply_to_message_id,
    mentioned_user_ids: legacy?.mentioned_user_ids,
    message_source: legacy?.message_source,
    payload: buildEnvelopePayload(content, parts),
  };
}

/** realtime push。`timestamp` 是**秒**（push.fbs 的 `uint`）。 */
export function canonicalFromPush(
  push: PushMessageRequest,
  content: string,
  message_type: string,
): CanonicalInboundMessage {
  return {
    server_message_id: push.server_message_id,
    local_message_id:
      push.local_message_id !== '0' ? push.local_message_id : undefined,
    channel_id: push.channel_id,
    channel_type: push.channel_type,
    from_uid: push.from_uid,
    message_type,
    content,
    metadata: metadataFromEnvelope(payloadAsText(push.payload)),
    pts: String(push.message_seq),
    sent_at_ms: normalizeSentAtMs(push.timestamp),
    sent_at_precision: 'seconds',
    revoked: push.deleted,
    payload: push.payload,
  };
}

/** `sync/get_difference` commit。 */
export function canonicalFromSyncCommit(args: {
  server_message_id: string;
  local_message_id?: string;
  channel_id: string;
  channel_type: number;
  from_uid: string;
  message_type: string;
  content: string;
  payload: Uint8Array;
  pts: string;
  sent_at_ms: number;
  revoked?: boolean;
  reply_to_message_id?: string;
  mentioned_user_ids?: string[];
}): CanonicalInboundMessage {
  return {
    ...args,
    metadata: metadataFromEnvelope(payloadAsText(args.payload)),
    sent_at_ms: normalizeSentAtMs(args.sent_at_ms),
    sent_at_precision: 'milliseconds',
    revoked: args.revoked ?? false,
  };
}

function payloadAsText(payload: Uint8Array): string | undefined {
  if (payload.length === 0 || payload[0] !== 0x7b /* '{' */) return undefined;
  try {
    return new TextDecoder().decode(payload);
  } catch {
    return undefined;
  }
}
