import { describe, expect, it } from 'vitest';
import {
  decodeEntityInvalidationBatch,
  encodeEntityInvalidationBatch,
  type EntityInvalidationBatch,
} from '../src/index.js';

describe('EntityInvalidationBatch', () => {
  it('round-trips large ids, scope, and mutation hints without number coercion', () => {
    const batch: EntityInvalidationBatch = {
      schema_version: 1,
      notification_id: '9007199254740993',
      items: [{
        entity_type: 'group_member',
        entity_id: '9007199254740995',
        scope: '9007199254740997',
        target_version: '9007199254740999',
        mutation_hint: 'delete',
      }],
      committed_at_ms: 1_780_000_000_123,
    };
    expect(decodeEntityInvalidationBatch(encodeEntityInvalidationBatch(batch))).toEqual(batch);
  });

  it('rejects an empty batch', () => {
    expect(() => encodeEntityInvalidationBatch({
      schema_version: 1,
      notification_id: '1',
      items: [],
      committed_at_ms: 1,
    })).toThrow(/item count/);
  });
});
