// 五条来源，一份共享 fixture，比 semantic projection。
//
// 这是两个线上事故的门禁：history 丢 metadata（图片永久灰块）、push 秒当毫秒
// （新消息排到会话最前）——两个都是「某条来源与其他来源不一致」。
//
// 比数据库行会假失败：行里的 `id` / `status` / 本地媒体状态本来就该不同。比
// semantic projection 才是这个问题本身。fixture 与 Rust 侧是同一个文件，不是两份
// 手抄——两份数据只会一直相等到有人改了其中一份。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agreesWith,
  canonicalFromHistory,
  canonicalFromPush,
  canonicalFromSendAck,
  canonicalFromSyncCommit,
  mergeSentAt,
  metadataFromEnvelope,
  normalizeSentAtMs,
  semanticProjection,
  type CanonicalInboundMessage,
  type SemanticProjection,
} from '../../src/cache/canonical-inbound.js';

interface Fixture {
  cases: Array<{
    name: string;
    expected: SemanticProjection & { metadata: Record<string, unknown> | null };
    sources: Record<string, Record<string, unknown>>;
  }>;
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../../privchat-docs/fixtures/canonical-inbound.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

/**
 * fixture 的 wire payload → **生产 adapter** 的入参。
 *
 * 这里只做「把 fixture 的中立编码还原成 wire 形态」，投影本身一律调 src 里的
 * adapter。上一版在这个文件里自己实现了 fromHistory/fromWire，结果测的是测试代码
 * 自己一致，而三条生产 mapper 一行没改——那种绿是最坏的一种绿。
 */
const WORD_FORM_BY_TAG: Record<number, string> = {
  0: 'text',
  1: 'voice',
  2: 'image',
  3: 'video',
  4: 'file',
  5: 'system',
};

function envelopeBytes(extra: unknown): Uint8Array {
  return typeof extra === 'string' && extra.length > 0
    ? new TextEncoder().encode(extra)
    : new Uint8Array();
}

function projectFixtureSource(
  path: string,
  p: Record<string, unknown>,
): CanonicalInboundMessage {
  if (path === 'history' || path === 'around') {
    return canonicalFromHistory(
      {
        message_id: String(p.message_id),
        channel_id: String(p.channel_id),
        sender_id: String(p.sender_id),
        content: String(p.content ?? ''),
        message_type: String(p.message_type ?? 'text'),
        timestamp: Number(p.timestamp ?? 0),
        message_seq:
          p.message_seq !== undefined ? Number(p.message_seq) : undefined,
        metadata: p.metadata as Record<string, unknown> | undefined,
        revoked: Boolean(p.revoked),
      } as Parameters<typeof canonicalFromHistory>[0],
      String(p.channel_id),
      1,
    );
  }
  if (path === 'push') {
    return canonicalFromPush(
      {
        server_message_id: String(p.server_message_id),
        local_message_id: String(p.local_message_id ?? '0'),
        channel_id: String(p.channel_id),
        channel_type: Number(p.channel_type ?? 1),
        from_uid: String(p.from_uid),
        message_seq: Number(p.message_seq ?? 0),
        // push.fbs 的 timestamp 是秒。
        timestamp: Number(p.timestamp_secs ?? 0),
        payload: envelopeBytes(p.extra),
        deleted: false,
      } as Parameters<typeof canonicalFromPush>[0],
      String(p.content ?? ''),
      WORD_FORM_BY_TAG[Number(p.message_type ?? 0)] ?? 'text',
    );
  }
  const common = {
    server_message_id: String(p.server_message_id),
    local_message_id:
      p.local_message_id !== undefined && String(p.local_message_id) !== '0'
        ? String(p.local_message_id)
        : undefined,
    channel_id: String(p.channel_id),
    channel_type: Number(p.channel_type ?? 1),
    from_uid: String(p.from_uid),
    message_type: WORD_FORM_BY_TAG[Number(p.message_type ?? 0)] ?? 'text',
    content: String(p.content ?? ''),
    payload: envelopeBytes(p.extra),
  };
  if (path === 'send_ack') {
    return canonicalFromSendAck({
      ...common,
      local_message_id: String(p.local_message_id ?? '0'),
      pts: String(p.message_seq ?? 0),
      sent_at_ms: Number(p.sent_at_ms ?? 0),
    });
  }
  return canonicalFromSyncCommit({
    ...common,
    pts: String(p.pts ?? 0),
    sent_at_ms: Number(p.timestamp ?? 0),
  });
}

describe('canonical inbound projection', () => {
  it('every source converges on the same semantic projection', () => {
    let checked = 0;
    expect(FIXTURE.cases.length).toBeGreaterThan(0);

    for (const testCase of FIXTURE.cases) {
      for (const [path, payload] of Object.entries(testCase.sources)) {
        if (path.startsWith('$')) continue;
        const actual = semanticProjection(projectFixtureSource(path, payload));
        expect(
          agreesWith(actual, testCase.expected),
          `${testCase.name}: ${path} 这条来源投影出来和其他来源不一致\n` +
            `  actual   = ${JSON.stringify(actual)}\n` +
            `  expected = ${JSON.stringify(testCase.expected)}`,
        ).toBe(true);
        checked += 1;
      }
    }
    // 五条来源都必须出现过，否则「全都一致」可能只是没测到。
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it('normalises seconds and milliseconds to the same instant', () => {
    const ms = 1_785_148_271_317;
    expect(normalizeSentAtMs(ms)).toBe(ms);
    // push 给的是秒；归一后必须落在同一秒，而不是 1970。
    expect(normalizeSentAtMs(Math.floor(ms / 1000))).toBe(Math.floor(ms / 1000) * 1000);
    expect(normalizeSentAtMs(Math.floor(ms / 1000))).toBeGreaterThan(100_000_000_000);
    expect(normalizeSentAtMs(0)).toBe(0);
  });

  it('merges send time by precision, not by arrival order', () => {
    const precise = { ms: 1_785_148_271_317, precision: 'milliseconds' as const };
    const coarse = { ms: 1_785_148_271_000, precision: 'seconds' as const };

    // 低精度永不覆盖高精度，方向无关。
    expect(mergeSentAt(precise, coarse)).toEqual({ ...precise, conflict: false });
    expect(mergeSentAt(coarse, precise)).toEqual({ ...precise, conflict: false });
    // 本地还没有值：直接采用。
    expect(mergeSentAt(undefined, coarse)).toEqual({ ...coarse, conflict: false });

    // 同精度但值不同 = 某一端数据坏了。发送时间是不变量，普通 replay 不许覆盖，
    // 只报冲突；「最后到达者获胜」恰恰是最没有权威性的规则。
    const later = { ms: precise.ms + 5_000, precision: 'milliseconds' as const };
    expect(mergeSentAt(precise, later)).toEqual({ ...precise, conflict: true });
  });

  it('tells "server sent no metadata" apart from "this path dropped it"', () => {
    // 前者是正确投影，后者是 bug——缩略图终态判定就卡在这个区别上。
    expect(metadataFromEnvelope(undefined)).toBeUndefined();
    expect(metadataFromEnvelope('')).toBeUndefined();
    expect(metadataFromEnvelope('{"content":"x"}')).toBeUndefined();
    expect(metadataFromEnvelope('{"content":"x","metadata":{"thumbnail_file_id":7119}}')).toEqual({
      thumbnail_file_id: 7119,
    });
  });
});
