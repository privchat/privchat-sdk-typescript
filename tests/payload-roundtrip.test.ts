import { describe, expect, it } from 'vitest';
import {
  decodeMessagePayloadEnvelope,
  encodeMessagePayloadEnvelope,
  type MessagePayloadEnvelope,
} from '../src/index.js';

const wrap = (overrides: Partial<MessagePayloadEnvelope> = {}): MessagePayloadEnvelope => ({
  content: '',
  mentioned_user_ids: [],
  ...overrides,
});

describe('MessagePayloadEnvelope (text-only)', () => {
  it('round-trips a plain text envelope', () => {
    const env = wrap({ content: 'hello world' });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('round-trips reply + mentions + source', () => {
    const env = wrap({
      content: '@alice @bob look',
      reply_to_message_id: '700110001',
      mentioned_user_ids: ['1001', '1002'],
      message_source: { source_type: 'group', source_id: 'g-42' },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });
});

describe('MessagePayloadEnvelope metadata variants', () => {
  it('image with all fields', () => {
    const env = wrap({
      content: '',
      metadata: {
        type: 'image',
        file_id: '500110001',
        url: 'https://cdn.example/img.jpg',
        width: 1920,
        height: 1080,
        thumbnail_file_id: '500110002',
        thumbnail_url: 'https://cdn.example/img-thumb.jpg',
        file_name: 'photo.jpg',
      },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('image without optional url', () => {
    const env = wrap({
      metadata: { type: 'image', file_id: '500110002', width: 100, height: 200 },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('file', () => {
    const env = wrap({
      metadata: {
        type: 'file',
        file_id: '500110003',
        file_name: 'report.pdf',
        file_size: 1_048_576,
        mime_type: 'application/pdf',
      },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('voice', () => {
    const env = wrap({
      metadata: { type: 'voice', file_id: '500110004', duration: 7, file_name: 'voice.m4a' },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('video full', () => {
    const env = wrap({
      metadata: {
        type: 'video',
        file_id: '500110005',
        duration: 30,
        width: 1280,
        height: 720,
        thumbnail_file_id: '500110006',
        thumbnail_width: 640,
        thumbnail_height: 360,
        thumbnail_url: 'https://cdn.example/video-thumb.jpg',
        file_name: 'clip.mp4',
      },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('video without thumbnail', () => {
    const env = wrap({
      metadata: { type: 'video', file_id: '500110007', duration: 5, width: 0, height: 0 },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('location', () => {
    const env = wrap({
      metadata: {
        type: 'location',
        latitude: 31.240018,
        longitude: 121.490317,
        coordinate_system: 'gcj02',
        name: 'The Bund',
        address: 'Zhongshan East 1st Road, Shanghai',
        poi_id: 'amap-poi-001',
        poi_source: 'amap',
        thumbnail_file_id: '500110007',
      },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('contact_card', () => {
    const env = wrap({
      metadata: { type: 'contact_card', user_id: '900710002' },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('sticker', () => {
    const env = wrap({
      metadata: { type: 'sticker', sticker_id: 'pack-1/sticker-3', image_url: 'https://cdn.example/s.png' },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('forward with multiple refs', () => {
    const env = wrap({
      metadata: {
        type: 'forward',
        messages: [
          { message_id: '700110001', content: 'hi', extra: new Uint8Array(0) },
          { content: 'inline only', extra: new TextEncoder().encode('{"v":1}') },
          { message_id: '700110002', extra: new Uint8Array(0) },
        ],
      },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('link with all optionals', () => {
    const env = wrap({
      metadata: {
        type: 'link',
        url: 'https://example.com/a',
        title: 'Example',
        description: 'A link',
        thumbnail_file_id: '500110008',
      },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });

  it('link with optionals absent', () => {
    const env = wrap({
      metadata: { type: 'link', url: 'https://example.com/' },
    });
    const got = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(env));
    expect(got).toEqual(env);
  });
});
