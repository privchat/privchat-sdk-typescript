// Collision-proof IndexedDB names for cache-backed client tests.
//
// `Date.now()` (millisecond resolution) is NOT unique enough: fast tests
// create clients within the same millisecond, so `prefix-${Date.now()}`
// can hand two tests the SAME IndexedDB. Under fake-indexeddb they then
// share state and one test's writes contaminate another's assertions —
// a flaky failure that only shows under full-suite parallel load.
//
// The monotonic counter defeats same-millisecond collisions within a
// worker; the random suffix defeats reuse across files/workers.

let counter = 0;

export function uniqueDbName(prefix: string): string {
  return `${prefix}-${++counter}-${Math.random().toString(36).slice(2, 10)}`;
}
