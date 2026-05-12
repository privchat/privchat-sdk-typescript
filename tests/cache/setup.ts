// Test setup: install fake-indexeddb globally so Dexie can run in Node.
// Imported via vitest.config.ts setupFiles for cache tests only — keeps
// the rest of the suite untouched.
import 'fake-indexeddb/auto';
