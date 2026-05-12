import { describe, expect, it } from 'vitest';
import {
  decodePingRequest,
  decodePongResponse,
  encodePingRequest,
  encodePongResponse,
} from '../src/index.js';

describe('PingRequest', () => {
  it('round-trips a current timestamp', () => {
    const msg = { timestamp: Date.now() };
    const bytes = encodePingRequest(msg);
    const got = decodePingRequest(bytes);
    expect(got.timestamp).toBe(msg.timestamp);
  });

  it('round-trips zero (default i64) and negative values', () => {
    for (const ts of [0, -1, -42_000, 1_700_000_000_000]) {
      const got = decodePingRequest(encodePingRequest({ timestamp: ts }));
      expect(got.timestamp).toBe(ts);
    }
  });
});

describe('PongResponse', () => {
  it('round-trips a timestamp', () => {
    const msg = { timestamp: 1_714_680_000_000 };
    const got = decodePongResponse(encodePongResponse(msg));
    expect(got.timestamp).toBe(msg.timestamp);
  });
});
