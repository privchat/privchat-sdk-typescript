// 服务端来的一条消息，规范化之后的样子。
//
// 五条来源——realtime push、`sync/get_difference` commit、`message/history/get`、
// `message/history/around`、send ACK——的 transport 形态本来就不一样：字段名不同、
// 时间单位不同（push 是秒，其余是毫秒）、metadata 有的在 envelope 里有的在顶层。
// 以前每条来源各自拼一份缓存投影，于是「同一条消息从哪条路进来」决定了它在本地长
// 什么样。两个线上事故就是这么来的：history 进来的图片没有 metadata（缩略图永远
// 下不来），push 进来的时间少了三个数量级（新消息排到会话最前）。
//
// 规则：**来源只做适配，不做投影**。
//
//   push / sync commit / history / around / send-ack
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
 * 已有值与新值指向同一秒时，保留精度更高的那个。
 *
 * 秒精度只可能来自 push；任何毫秒值都更接近真实发送时刻。跨秒则以新值为准（那是
 * 真的更新，不是精度差）。不这样做的话，一条 history 拿到 .317 的消息会被随后的
 * push 改成 .000，显示时间跟着「最后一条到达的路径」抖。
 */
export function preferPreciseSentAt(existingMs: number, incomingMs: number): number {
  if (existingMs > 0 && Math.floor(existingMs / 1000) === Math.floor(incomingMs / 1000)) {
    return Math.max(existingMs, incomingMs);
  }
  return incomingMs;
}

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
  revoked: boolean;
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
