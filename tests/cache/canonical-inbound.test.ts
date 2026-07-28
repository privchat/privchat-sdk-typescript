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
  metadataFromEnvelope,
  normalizeSentAtMs,
  preferPreciseSentAt,
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

/** wire message_type 字符串 → canonical word form。与 Rust 判别值一一对应。 */
const WORD_FORM: Record<string, string> = {
  text: 'text',
  voice: 'voice',
  image: 'image',
  video: 'video',
  file: 'file',
  system: 'system',
};
const WORD_FORM_BY_TAG: Record<number, string> = {
  0: 'text',
  1: 'voice',
  2: 'image',
  3: 'video',
  4: 'file',
  5: 'system',
};

function fromHistory(p: Record<string, unknown>): CanonicalInboundMessage {
  return {
    server_message_id: String(p.message_id),
    channel_id: String(p.channel_id),
    channel_type: 1,
    from_uid: String(p.sender_id),
    message_type: WORD_FORM[String(p.message_type)] ?? 'text',
    content: String(p.content ?? ''),
    metadata: (p.metadata as Record<string, unknown> | undefined) ?? undefined,
    pts: String(p.message_seq ?? 0),
    sent_at_ms: normalizeSentAtMs(Number(p.timestamp ?? 0)),
    revoked: Boolean(p.revoked),
  };
}

function fromWire(p: Record<string, unknown>, secondsField?: string): CanonicalInboundMessage {
  const raw = secondsField !== undefined ? Number(p[secondsField]) : Number(p.timestamp ?? p.sent_at_ms);
  return {
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
    metadata: metadataFromEnvelope(p.extra as string | undefined),
    pts: String(p.pts ?? p.message_seq ?? 0),
    sent_at_ms: normalizeSentAtMs(raw),
    revoked: false,
  };
}

describe('canonical inbound projection', () => {
  it('every source converges on the same semantic projection', () => {
    let checked = 0;
    expect(FIXTURE.cases.length).toBeGreaterThan(0);

    for (const testCase of FIXTURE.cases) {
      for (const [path, payload] of Object.entries(testCase.sources)) {
        if (path.startsWith('$')) continue;
        const canonical =
          path === 'history' || path === 'around'
            ? fromHistory(payload)
            : fromWire(payload, path === 'push' ? 'timestamp_secs' : undefined);

        const actual = semanticProjection(canonical);
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

  it('never lets a second-resolution source degrade a millisecond value', () => {
    const precise = 1_785_148_271_317;
    const coarse = 1_785_148_271_000;
    expect(preferPreciseSentAt(precise, coarse)).toBe(precise);
    expect(preferPreciseSentAt(coarse, precise)).toBe(precise);
    // 跨秒是真的更新，必须跟上。
    expect(preferPreciseSentAt(precise, precise + 5_000)).toBe(precise + 5_000);
    expect(preferPreciseSentAt(0, coarse)).toBe(coarse);
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
