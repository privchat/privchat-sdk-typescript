// In-memory store unit tests for R2A user/group profile cache.

import { describe, expect, it, vi } from 'vitest';
import {
  FriendshipStore,
  GroupStore,
  UserStore,
  type FriendshipRecord,
  type GroupRecord,
  type UserRecord,
} from '../../src/cache/index.js';

const u = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  user_id: '100',
  username: 'alice',
  nickname: 'Alice',
  user_type: 0,
  is_friend: false,
  sync_version: 1,
  ...overrides,
});

const g = (overrides: Partial<GroupRecord> = {}): GroupRecord => ({
  group_id: '500',
  name: 'Test',
  member_count: 3,
  sync_version: 1,
  ...overrides,
});

describe('UserStore', () => {
  it('upsert + get + list', () => {
    const s = new UserStore();
    s.upsert(u({ user_id: '1' }));
    s.upsert(u({ user_id: '2', username: 'bob' }));
    expect(s.get('1')?.username).toBe('alice');
    expect(s.get('2')?.username).toBe('bob');
    expect(s.list()).toHaveLength(2);
  });

  it('upsertMany batches multiple records into one observer fire', () => {
    const s = new UserStore();
    const cb = vi.fn();
    s.observe(cb);
    s.upsertMany([u({ user_id: '1' }), u({ user_id: '2' }), u({ user_id: '3' })]);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('upsertMany with empty array is a no-op', () => {
    const s = new UserStore();
    const cb = vi.fn();
    s.observe(cb);
    s.upsertMany([]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('upsert overwrites existing record by user_id', () => {
    const s = new UserStore();
    s.upsert(u({ user_id: '1', nickname: 'Old', sync_version: 1 }));
    s.upsert(u({ user_id: '1', nickname: 'New', sync_version: 2 }));
    expect(s.get('1')?.nickname).toBe('New');
    expect(s.get('1')?.sync_version).toBe(2);
    expect(s.list()).toHaveLength(1);
  });

  it('maxSyncVersion returns the highest seen version', () => {
    const s = new UserStore();
    s.upsertMany([
      u({ user_id: '1', sync_version: 5 }),
      u({ user_id: '2', sync_version: 12 }),
      u({ user_id: '3', sync_version: 8 }),
    ]);
    expect(s.maxSyncVersion()).toBe(12);
  });

  it('observe + unsubscribe', () => {
    const s = new UserStore();
    const cb = vi.fn();
    const off = s.observe(cb);
    s.upsert(u({ user_id: '1' }));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    s.upsert(u({ user_id: '2' }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clear emits an empty snapshot to observers', () => {
    const s = new UserStore();
    s.upsert(u({ user_id: '1' }));
    const cb = vi.fn();
    s.observe(cb);
    s.clear();
    expect(cb).toHaveBeenCalledWith([]);
    expect(s.list()).toHaveLength(0);
  });

  it('listener errors do not break the emit loop', () => {
    const s = new UserStore();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    s.observe(bad);
    s.observe(good);
    s.upsert(u({ user_id: '1' }));
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});

describe('GroupStore', () => {
  it('upsert + get + list keyed by group_id', () => {
    const s = new GroupStore();
    s.upsert(g({ group_id: '100', name: 'Engineering' }));
    s.upsert(g({ group_id: '200', name: 'Design' }));
    expect(s.get('100')?.name).toBe('Engineering');
    expect(s.get('200')?.name).toBe('Design');
    expect(s.list()).toHaveLength(2);
  });

  it('maxSyncVersion + size', () => {
    const s = new GroupStore();
    s.upsertMany([g({ group_id: '1', sync_version: 7 }), g({ group_id: '2', sync_version: 3 })]);
    expect(s.maxSyncVersion()).toBe(7);
    expect(s.size()).toBe(2);
  });
});

const f = (overrides: Partial<FriendshipRecord> = {}): FriendshipRecord => ({
  user_id: '500',
  alias: '老王',
  created_at: 1_000,
  updated_at: 2_000,
  sync_version: 1,
  ...overrides,
});

describe('FriendshipStore', () => {
  it('upsert + get + list keyed by user_id', () => {
    const s = new FriendshipStore();
    s.upsert(f({ user_id: '500', alias: '老王' }));
    s.upsert(f({ user_id: '600', alias: 'Bob' }));
    expect(s.get('500')?.alias).toBe('老王');
    expect(s.get('600')?.alias).toBe('Bob');
    expect(s.list()).toHaveLength(2);
  });

  it('remove deletes by user_id (idempotent)', () => {
    const s = new FriendshipStore();
    s.upsert(f({ user_id: '500' }));
    expect(s.size()).toBe(1);
    s.remove('500');
    expect(s.get('500')).toBeUndefined();
    expect(s.size()).toBe(0);
    // Removing a missing id is silent.
    s.remove('500');
    expect(s.size()).toBe(0);
  });

  it('applyDelta upserts + deletes in a single observer fire', () => {
    const s = new FriendshipStore();
    s.upsert(f({ user_id: '500', alias: 'old' }));
    const cb = vi.fn();
    s.observe(cb);
    cb.mockClear();
    s.applyDelta(
      [f({ user_id: '600', alias: 'new' }), f({ user_id: '500', alias: 'updated' })],
      ['700' /* tombstone for a uid we don't have — should be no-op for the delete half */],
    );
    expect(cb).toHaveBeenCalledTimes(1);
    expect(s.get('500')?.alias).toBe('updated');
    expect(s.get('600')?.alias).toBe('new');
  });

  it('applyDelta deletion path drops the row', () => {
    const s = new FriendshipStore();
    s.upsert(f({ user_id: '500' }));
    s.upsert(f({ user_id: '600' }));
    s.applyDelta([], ['500']);
    expect(s.get('500')).toBeUndefined();
    expect(s.get('600')).toBeDefined();
  });

  it('applyDelta with empty input is a no-op', () => {
    const s = new FriendshipStore();
    const cb = vi.fn();
    s.observe(cb);
    s.applyDelta([], []);
    expect(cb).not.toHaveBeenCalled();
  });
});
