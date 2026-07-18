import * as flatbuffers from 'flatbuffers';
import { EntityInvalidationBatch as FbEntityInvalidationBatch } from '../generated/privchat/protocol/entity-invalidation-batch.js';
import { EntityInvalidation as FbEntityInvalidation } from '../generated/privchat/protocol/entity-invalidation.js';
import { EntityMutationHint as FbEntityMutationHint } from '../generated/privchat/protocol/entity-mutation-hint.js';
import { bigintToIdString, idStringToBigint } from './ids.js';

export const ENTITY_INVALIDATION_PUSH_TOPIC_V1 = 'entity.invalidation.v1';
export const ENTITY_INVALIDATION_MAX_ITEMS_V1 = 128;

export type EntityMutationHint = 'unknown' | 'upsert' | 'delete';

export interface EntityInvalidation {
  entity_type: string;
  entity_id?: string;
  scope?: string;
  target_version: string;
  mutation_hint: EntityMutationHint;
}

export interface EntityInvalidationBatch {
  schema_version: number;
  notification_id: string;
  items: EntityInvalidation[];
  committed_at_ms: number;
}

const toFbHint = (hint: EntityMutationHint): FbEntityMutationHint => {
  switch (hint) {
    case 'upsert': return FbEntityMutationHint.Upsert;
    case 'delete': return FbEntityMutationHint.Delete;
    default: return FbEntityMutationHint.Unknown;
  }
};

const fromFbHint = (hint: FbEntityMutationHint): EntityMutationHint => {
  switch (hint) {
    case FbEntityMutationHint.Upsert: return 'upsert';
    case FbEntityMutationHint.Delete: return 'delete';
    default: return 'unknown';
  }
};

export function encodeEntityInvalidationBatch(batch: EntityInvalidationBatch): Uint8Array {
  if (batch.items.length === 0 || batch.items.length > ENTITY_INVALIDATION_MAX_ITEMS_V1) {
    throw new Error(`entity invalidation item count must be 1..=${ENTITY_INVALIDATION_MAX_ITEMS_V1}`);
  }
  const builder = new flatbuffers.Builder(512);
  const offsets = batch.items.map((item) => {
    if (item.entity_type.trim() === '') throw new Error('entity_type must not be blank');
    const typeOffset = builder.createString(item.entity_type);
    const idOffset = item.entity_id === undefined ? 0 : builder.createString(item.entity_id);
    const scopeOffset = item.scope === undefined ? 0 : builder.createString(item.scope);
    return FbEntityInvalidation.createEntityInvalidation(
      builder,
      typeOffset,
      idOffset,
      scopeOffset,
      idStringToBigint(item.target_version),
      toFbHint(item.mutation_hint),
    );
  });
  const itemsOffset = FbEntityInvalidationBatch.createItemsVector(builder, offsets);
  const root = FbEntityInvalidationBatch.createEntityInvalidationBatch(
    builder,
    batch.schema_version,
    idStringToBigint(batch.notification_id),
    itemsOffset,
    BigInt(batch.committed_at_ms),
  );
  builder.finish(root);
  return builder.asUint8Array();
}

export function decodeEntityInvalidationBatch(bytes: Uint8Array): EntityInvalidationBatch {
  const view = FbEntityInvalidationBatch.getRootAsEntityInvalidationBatch(
    new flatbuffers.ByteBuffer(bytes),
  );
  const length = view.itemsLength();
  if (length === 0 || length > ENTITY_INVALIDATION_MAX_ITEMS_V1) {
    throw new Error(`entity invalidation item count must be 1..=${ENTITY_INVALIDATION_MAX_ITEMS_V1}`);
  }
  const items: EntityInvalidation[] = [];
  for (let i = 0; i < length; i++) {
    const item = view.items(i);
    if (item === null) throw new Error(`entity invalidation item ${i} is missing`);
    const entityType = item.entityType() ?? '';
    if (entityType.trim() === '') throw new Error('entity_type must not be blank');
    items.push({
      entity_type: entityType,
      ...(item.entityId() === null ? {} : { entity_id: item.entityId()! }),
      ...(item.scope() === null ? {} : { scope: item.scope()! }),
      target_version: bigintToIdString(item.targetVersion()),
      mutation_hint: fromFbHint(item.mutationHint()),
    });
  }
  return {
    schema_version: view.schemaVersion(),
    notification_id: bigintToIdString(view.notificationId()),
    items,
    committed_at_ms: Number(view.committedAtMs()),
  };
}
