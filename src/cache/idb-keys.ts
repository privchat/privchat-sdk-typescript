// Shared cache_metadata KEY CONSTANTS — a deliberately dexie-free module.
//
// Both the schema (class migrations) and the operation functions need these
// strings. If they lived in `idb-schema.ts`, the ops module's value import
// would drag the schema — and dexie with it — back into every consumer's
// bundle, which is exactly what the schema/ops split exists to prevent.

/** cache_metadata key: which authenticated user owns this database. */
export const CACHE_OWNER_KEY = 'owner_user_id';

/** cache_metadata key: high-water mark of the local display-order sequence. */
export const LOCAL_ORDER_SEQ_KEY = 'local_order_seq_high_water';

export const ORDER_MODE_PREFIX = 'channel_order_mode:';
export const orderModeKey = (channel_id: string): string =>
  ORDER_MODE_PREFIX + channel_id;
