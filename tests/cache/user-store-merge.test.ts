import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheDB } from '../../src/cache-idb.js';
import { upsertUsers } from '../../src/cache/indexeddb-store.js';
import type { UserRecord } from '../../src/cache/types.js';

let dbSeq = 0;
function newDb(): CacheDB {
  return new CacheDB(`user-merge-${dbSeq++}`);
}

function rec(over: Partial<UserRecord>): UserRecord {
  return {
    user_id: '36',
    username: 'acct',
    nickname: undefined,
    avatar_url: undefined,
    user_type: 0,
    is_friend: false,
    sync_version: 0,
    ...over,
  };
}

async function read(db: CacheDB): Promise<UserRecord | undefined> {
  return db.users.get('36');
}

/**
 * The web/h5 half of ENTITY_INVALIDATION_SYNC_SPEC §4.2. These are the same
 * three situations the Rust SDK hit in production; `bulkPut` lost to all of
 * them silently, which is the worst way to lose — the row simply ends up wrong
 * and nothing later corrects it.
 */
describe('user profile merge', () => {
  it('keeps the newer snapshot when a stale detail response arrives late', async () => {
    const db = newDb();
    await upsertUsers(db, [rec({ nickname: 'A', sync_version: 60 })]);
    await upsertUsers(db, [rec({ nickname: 'B', sync_version: 61 })]);
    // The detail request read version 60 before the entity update landed.
    await upsertUsers(db, [rec({ nickname: 'A', sync_version: 60 })]);
    expect((await read(db))?.nickname).toBe('B');
    expect((await read(db))?.sync_version).toBe(61);
  });

  it('does not let a versionless write resurrect an authoritative clear', async () => {
    const db = newDb();
    await upsertUsers(db, [
      rec({ nickname: 'Named', avatar_url: 'https://cdn/a.png', sync_version: 60 }),
    ]);
    // The owner cleared both.
    await upsertUsers(db, [rec({ nickname: '', avatar_url: '', sync_version: 61 })]);
    expect((await read(db))?.avatar_url).toBe('');

    // A channel-member row still carrying last week's values, claiming no version.
    await upsertUsers(db, [
      rec({
        username: 'acct',
        nickname: 'Named',
        avatar_url: 'https://cdn/a.png',
        sync_version: 0,
      }),
    ]);
    expect((await read(db))?.avatar_url).toBe('');
    expect((await read(db))?.nickname).toBe('');
  });

  it('lets a versionless write fill only what is locally missing', async () => {
    const db = newDb();
    // No snapshot yet: a partial writer may contribute what it knows.
    await upsertUsers(db, [
      rec({ username: 'acct', nickname: undefined, sync_version: 0 }),
    ]);
    expect((await read(db))?.username).toBe('acct');

    // The authoritative profile arrives and takes ownership.
    await upsertUsers(db, [rec({ username: '', nickname: 'Real', sync_version: 70 })]);
    expect((await read(db))?.nickname).toBe('Real');

    // A later partial writer must not touch the owned fields any more.
    await upsertUsers(db, [rec({ nickname: 'Guessed', sync_version: 0 })]);
    expect((await read(db))?.nickname).toBe('Real');
  });

  it('treats undefined as no information and empty string as a clear', async () => {
    const db = newDb();
    await upsertUsers(db, [rec({ nickname: 'Named', sync_version: 10 })]);
    // Higher version but no nickname information at all.
    await upsertUsers(db, [rec({ nickname: undefined, sync_version: 20 })]);
    expect((await read(db))?.nickname).toBe('Named');
    // The server saying the nickname is empty.
    await upsertUsers(db, [rec({ nickname: '', sync_version: 30 })]);
    expect((await read(db))?.nickname).toBe('');
  });
});
