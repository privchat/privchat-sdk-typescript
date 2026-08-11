// 附件消息发出去的 wire 正文里到底有什么。
//
// 🔴 必须解码 builder 产出的 payload 来看：`[图片]` 这类占位文案是**展示层**按消息
// 类型和当前语言现取的，一旦混进 wire，它就会跟着消息跑到别的语言的客户端上，而且
// 「没写说明」和「说明恰好是 [图片]」再也分不开。
//
// 现有 `media-builders-send` 只验能不能入 outbox，把占位文案放回去它照样绿。

import { describe, expect, it } from 'vitest';
import {
  buildSendFileInput,
  buildSendImageInput,
  buildSendVideoInput,
  buildSendVoiceInput,
  decodeMessagePayloadEnvelope,
} from '../../src/index.js';

const CHANNEL = { channel_id: '77', channel_type: 1, from_uid: '9' } as const;

function wireContent(input: { payload?: Uint8Array }): string {
  expect(input.payload).toBeInstanceOf(Uint8Array);
  return decodeMessagePayloadEnvelope(input.payload!).content;
}

const image = (caption?: string) =>
  buildSendImageInput({
    ...CHANNEL,
    caption,
    metadata: { file_id: '901', width: 10, height: 10, thumbnail_file_id: '902' },
    local_message_id: '1',
  });

describe('media captions on the wire', () => {
  it('carries nothing when the user wrote nothing', () => {
    expect(wireContent(image())).toBe('');
    expect(wireContent(image(''))).toBe('');
  });

  it('carries the caption verbatim', () => {
    expect(wireContent(image('周末爬山'))).toBe('周末爬山');
  });

  // 🔴 说明文字恰好长得像占位文案，也必须原样带走——发送端一旦自己会生成
  // 「[图片]」，这两种情况就永远分不开了。
  it('carries a caption that looks like a placeholder', () => {
    expect(wireContent(image('[图片]'))).toBe('[图片]');
  });

  it('leaves the body empty for the other media kinds too', () => {
    expect(
      wireContent(
        buildSendVideoInput({
          ...CHANNEL,
          metadata: { file_id: '904', width: 320, height: 240, duration: 5, thumbnail_file_id: '905' },
          local_message_id: '2',
        }),
      ),
    ).toBe('');
    expect(
      wireContent(
        buildSendFileInput({
          ...CHANNEL,
          metadata: { file_id: '906', filename: '合同.pdf', size: 12 },
          local_message_id: '3',
        }),
      ),
    ).toBe('');
    expect(
      wireContent(
        buildSendVoiceInput({
          ...CHANNEL,
          metadata: { file_id: '903', duration: 3 },
          local_message_id: '4',
        }),
      ),
    ).toBe('');
  });
});
