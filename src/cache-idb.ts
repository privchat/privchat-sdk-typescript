// `@privchat/sdk/cache-idb` — the IndexedDB persistence entry.
//
// The ONLY path that reaches dexie as a value. Kept off the main entry so
// bundlers ship IndexedDB machinery exclusively to consumers that construct
// it and inject via `PrivchatClientOptions.cache.db`.
export { CacheDB } from './cache/idb-schema.js';
