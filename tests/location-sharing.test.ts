import { describe, expect, it } from 'vitest';
import {
  decodeMessagePayloadEnvelope,
  encodeMessagePayloadEnvelope,
  type MessagePayloadEnvelope,
} from '../src/index.js';

describe('independent location sharing wire compatibility (not transport acceptance)', () => {
  it.each(['wgs84', 'gcj02', 'bd09'])('preserves minimal coordinate message: %s', (crs) => {
    const sent: MessagePayloadEnvelope = {
      content: '0,0',
      mentioned_user_ids: [],
      metadata: { type: 'location', latitude: 0, longitude: 0, coordinate_system: crs },
    };
    const received = decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(sent));
    expect(received).toEqual(sent);
    expect(received.metadata).toMatchObject({
      poi_id: undefined, poi_source: undefined, thumbnail_file_id: undefined,
    });
    // Re-encoding a received/synchronized payload must not add vendor fields.
    expect(decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(received))).toEqual(sent);
  });

  it.each([undefined, 'future-crs'])('retains legacy/unknown CRS without inventing a replacement: %s', (crs) => {
    const sent: MessagePayloadEnvelope = {
      content: 'Legacy location',
      mentioned_user_ids: [],
      metadata: {
        type: 'location', latitude: 1.25, longitude: 103.75,
        ...(crs === undefined ? {} : { coordinate_system: crs }),
        thumbnail_file_id: '9007199254740993',
      },
    };
    expect(decodeMessagePayloadEnvelope(encodeMessagePayloadEnvelope(sent))).toEqual(sent);
  });
});
