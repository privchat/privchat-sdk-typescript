import { describe, expect, it } from 'vitest';
import { InvalidDeviceIdError, isCanonicalDeviceId, newDeviceId } from '../src/index.js';

describe('device id', () => {
  it('new ids are canonical lowercase v4 from both random sources', () => {
    expect(Array.from({ length: 200 }, newDeviceId).every(isCanonicalDeviceId)).toBe(true);
    const saved = crypto.randomUUID;
    (crypto as { randomUUID?: unknown }).randomUUID = undefined;
    try {
      expect(Array.from({ length: 200 }, newDeviceId).every(isCanonicalDeviceId)).toBe(true);
    } finally {
      (crypto as { randomUUID?: unknown }).randomUUID = saved;
    }
  });

  it('only the canonical form is a device id', () => {
    expect(isCanonicalDeviceId('91710a71-f3ed-4fe5-8220-b96d02a9ce6e')).toBe(true);
    for (const bad of ['91710A71-F3ED-4FE5-8220-B96D02A9CE6E', '15c5b1ee-02cb-3122-8f0a-6a1c3e2d9b77',
      '91710a71f3ed4fe58220b96d02a9ce6e', '91710a71-f3ed-4fe5-7220-b96d02a9ce6e', 'd-mv7w83ig-2hyz0', ''])
      expect(isCanonicalDeviceId(bad)).toBe(false);
  });
});
