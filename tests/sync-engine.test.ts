// Phase 5B-1c unit tests for SyncEngine. Covers the 11 cases listed in
// docs/PHASE5B_SYNC_ENGINE_PLAN.md → Test plan → Unit.
//
// Tests construct the engine directly with mock deps rather than going
// through PrivchatClient — keeps the cases focused on engine semantics
// (mutex, merge, unread bump, resync) without dragging in the transport
// + auth dance. The PrivchatClient → engine wiring is exercised by the
// accounts E2E (5B-1e).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheDB, MessageStore } from '../src/cache/index.js';
import {
  SyncEngine,
  SyncRpcError,
  SYNC_CHANNEL_RESYNC_REQUIRED,
  SYNC_FULL_REBUILD_REQUIRED,
  commitToMessageRecord,
  type SyncEngineDeps,
} from '../src/sync-engine.js';
import type {
  GetDifferenceRequest,
  GetDifferenceResponse,
  ServerCommit,
} from '../src/api-types.js';
import type {
  ChannelRecord,
  ConversationPatch,
  MessageRecord,
} from '../src/cache/index.js';
import type { SdkEvent } from '../src/events.js';

// ----- Helpers -----

const CHANNEL_ID = '100';
const CHANNEL_TYPE = 1;
const SELF_UID = 'self-1';
const PEER_UID = 'peer-2';

let dbCounter = 0;
const dbs: CacheDB[] = [];
afterEach(async () => {
  while (dbs.length > 0) {
    const db = dbs.pop()!;
    try {
      await db.close();
    } catch {
      /* ignore */
    }
  }
});

function newDb(): CacheDB {
  const db = new CacheDB(`sync-engine-${++dbCounter}-${Math.random().toString(36).slice(2, 8)}`);
  dbs.push(db);
  return db;
}

interface EngineHarness {
  engine: SyncEngine;
  store: MessageStore;
  db: CacheDB;
  events: SdkEvent[];
  pageQueue: GetDifferenceResponse[];
  errorQueue: Array<SyncRpcError | undefined>;
  callsLog: GetDifferenceRequest[];
  openConvCalls: Array<{ channel_id: string; channel_type: number }>;
  openConvImpl: (channel_id: string, channel_type: number) => Promise<MessageRecord[]>;
}

interface HarnessOpts {
  selfUid?: string;
  pageLimit?: number;
  maxPages?: number;
  /** Override openConversation for tests that exercise resync recovery. */
  openConv?: (channel_id: string, channel_type: number) => Promise<MessageRecord[]>;
}

function newHarness(opts: HarnessOpts = {}): EngineHarness {
  const store = new MessageStore();
  const db = newDb();
  const events: SdkEvent[] = [];
  const pageQueue: GetDifferenceResponse[] = [];
  const errorQueue: Array<SyncRpcError | undefined> = [];
  const callsLog: GetDifferenceRequest[] = [];
  const openConvCalls: EngineHarness['openConvCalls'] = [];
  const openConvImpl =
    opts.openConv ??
    (async () => {
      return [] as MessageRecord[];
    });

  const callDifference: SyncEngineDeps['callDifference'] = async (req) => {
    callsLog.push(req);
    const err = errorQueue.shift();
    if (err) throw err;
    const resp = pageQueue.shift();
    if (!resp) {
      throw new Error(
        `test misconfiguration: no queued response for sync/get_difference (call #${callsLog.length})`,
      );
    }
    return resp;
  };

  const openConversation: SyncEngineDeps['openConversation'] = async (cid, ct) => {
    openConvCalls.push({ channel_id: cid, channel_type: ct });
    return openConvImpl(cid, ct);
  };

  const engine = new SyncEngine({
    db,
    store,
    callDifference,
    openConversation,
    getCurrentUserId: () => opts.selfUid,
    emit: (e) => events.push(e),
    pageLimit: opts.pageLimit,
    maxPages: opts.maxPages,
    warn: () => {
      /* swallow noise in tests */
    },
  });

  return {
    engine,
    store,
    db,
    events,
    pageQueue,
    errorQueue,
    callsLog,
    openConvCalls,
    openConvImpl,
  };
}

function seedChannel(
  store: MessageStore,
  overrides: Partial<ChannelRecord> = {},
): ChannelRecord {
  const rec: ChannelRecord = {
    channel_id: CHANNEL_ID,
    channel_type: CHANNEL_TYPE,
    title: 'test',
    latest_pts: '0',
    read_pts: '0',
    unread_count: 0,
    updated_at: 0,
    sync_version: 1,
    ...overrides,
  };
  store.upsertChannel(rec);
  return rec;
}

function commit(
  pts: number,
  overrides: Partial<ServerCommit> = {},
): ServerCommit {
  return {
    pts: String(pts),
    server_msg_id: String(1_000 + pts),
    channel_id: CHANNEL_ID,
    channel_type: CHANNEL_TYPE,
    message_type: 'text',
    content: `body-${pts}`,
    server_timestamp: 1_700_000_000_000 + pts * 1000,
    sender_id: PEER_UID,
    ...overrides,
  };
}

function okPage(
  commits: ServerCommit[],
  current_pts: number,
  has_more = false,
): GetDifferenceResponse {
  return { commits, current_pts: String(current_pts), has_more };
}

function ptsErr(code: number, dataObj?: Record<string, unknown>): SyncRpcError {
  return new SyncRpcError({
    code,
    message: 'mock',
    dataBytes:
      dataObj === undefined
        ? undefined
        : new TextEncoder().encode(JSON.stringify(dataObj)),
  });
}

// ----- Tests -----

describe('SyncEngine', () => {
  describe('Case 1: empty response → status=current', () => {
    it('returns current with no patches when commits=[] and has_more=false', async () => {
      const h = newHarness();
      seedChannel(h.store);
      const patches: ConversationPatch[] = [];
      h.store.observeConversation(CHANNEL_ID, CHANNEL_TYPE, (_, p) => patches.push(p));

      h.pageQueue.push(okPage([], 0));
      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      expect(res.status).toBe('current');
      expect(res.commits_applied).toBe(0);
      expect(res.pages_fetched).toBe(1);
      expect(patches).toHaveLength(0);
    });
  });

  describe('Case 2: single page → 3 upserts + latest_pts advance', () => {
    it('applies all commits and lifts latest_pts to last commit pts', async () => {
      const h = newHarness();
      seedChannel(h.store);
      const patches: ConversationPatch[] = [];
      h.store.observeConversation(CHANNEL_ID, CHANNEL_TYPE, (_, p) => patches.push(p));

      h.pageQueue.push(okPage([commit(1), commit(2), commit(3)], 3));
      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      expect(res.status).toBe('synced');
      expect(res.commits_applied).toBe(3);
      expect(res.latest_pts_after).toBe('3');
      expect(h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)?.latest_pts).toBe('3');
      expect(patches).toHaveLength(1);
      expect(patches[0]!.upserted.map((m) => m.server_message_id)).toEqual([
        '1001', '1002', '1003',
      ]);
    });
  });

  describe('Case 3: two pages → 2 RPCs + 6 commits in order', () => {
    it('paginates with cursor advance and applies all commits', async () => {
      const h = newHarness();
      seedChannel(h.store);
      h.pageQueue.push(okPage([commit(1), commit(2), commit(3)], 6, true));
      h.pageQueue.push(okPage([commit(4), commit(5), commit(6)], 6, false));

      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      expect(h.callsLog).toHaveLength(2);
      expect(h.callsLog[0]!.last_pts).toBe('0');
      expect(h.callsLog[1]!.last_pts).toBe('3'); // advanced to last applied commit pts
      expect(res.commits_applied).toBe(6);
      expect(res.pages_fetched).toBe(2);
      expect(h.store.getMessages(CHANNEL_ID, CHANNEL_TYPE).map((m) => m.server_message_id))
        .toEqual(['1001', '1002', '1003', '1004', '1005', '1006']);
    });
  });

  describe('Case 4: local-echo ACK via sync', () => {
    it('emits removed=[l:L] + upserted=[s:S] when commit echoes local_message_id', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store);

      // Pre-seed a pending row keyed by l:9, in BOTH memory + IndexedDB
      // (IndexedDB seed is what makes the swap test meaningful — we want
      // to confirm the persisted pending row is deleted alongside the
      // memory row, not just shadowed by the new acked row).
      const pending: MessageRecord = {
        channel_id: CHANNEL_ID,
        channel_type: CHANNEL_TYPE,
        local_message_id: '9',
        from_uid: SELF_UID,
        message_type: 'text',
        content: 'hello',
        payload: new Uint8Array(),
        timestamp: 1_700_000_000_500,
        status: 'pending',
      };
      h.store.upsertMessage(pending, false);
      const { upsertMessage: persistOne } = await import('../src/cache/index.js');
      await persistOne(h.db, pending);

      const patches: ConversationPatch[] = [];
      h.store.observeConversation(CHANNEL_ID, CHANNEL_TYPE, (_, p) => patches.push(p));

      h.pageQueue.push(
        okPage(
          [
            commit(7, {
              server_msg_id: '4242',
              local_message_id: '9',
              sender_id: SELF_UID,
            }),
          ],
          7,
        ),
      );

      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      // Wait for the fire-and-forget IndexedDB transaction to settle.
      await new Promise((r) => setTimeout(r, 20));

      expect(res.commits_applied).toBe(0); // ACK swap is NOT a newly inserted commit
      expect(patches).toHaveLength(1);
      expect(patches[0]!.removed).toEqual(['l:9']);
      expect(patches[0]!.upserted[0]!.server_message_id).toBe('4242');
      expect(patches[0]!.upserted[0]!.local_message_id).toBe('9');
      expect(patches[0]!.upserted[0]!.status).toBe('sent');

      // Buffer now contains exactly one row keyed by s:4242.
      const buffer = h.store.getMessages(CHANNEL_ID, CHANNEL_TYPE);
      expect(buffer).toHaveLength(1);
      expect(buffer[0]!.server_message_id).toBe('4242');

      // IndexedDB: pending row gone, acked row present.
      const persisted = await h.db.messages.toArray();
      expect(persisted.map((m) => m.record_key).sort()).toEqual(['s:4242']);
    });
  });

  describe('Case 5: idempotent re-application', () => {
    it('second sync emits zero patches and unread stays put', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store, { read_pts: '0', unread_count: 0 });

      // First pass: 2 commits from peer.
      h.pageQueue.push(okPage([commit(1), commit(2)], 2));
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      const afterFirst = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(afterFirst.latest_pts).toBe('2');
      expect(afterFirst.unread_count).toBe(2);

      // Observer attached AFTER first pass — sees only the second pass.
      const patches: ConversationPatch[] = [];
      h.store.observeConversation(CHANNEL_ID, CHANNEL_TYPE, (_, p) => patches.push(p));

      // Second pass: same commits. Server returns same payload because nothing
      // moved. Engine should detect dedupe-skip on each commit.
      h.pageQueue.push(okPage([commit(1), commit(2)], 2));
      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      expect(res.commits_applied).toBe(0);
      expect(patches).toHaveLength(0);
      const afterSecond = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(afterSecond.latest_pts).toBe('2');
      expect(afterSecond.unread_count).toBe(2); // NOT doubled
    });
  });

  describe('Case 6: 20900 stale cursor → resync', () => {
    it('drops buffer, fires openConversation, resets latest_pts to 0', async () => {
      const remoteRefill: MessageRecord[] = [
        {
          channel_id: CHANNEL_ID,
          channel_type: CHANNEL_TYPE,
          server_message_id: '99',
          from_uid: PEER_UID,
          message_type: 'text',
          content: 'restored',
          payload: new Uint8Array(),
          timestamp: 1_700_000_999_000,
          status: 'received',
        },
      ];
      const h = newHarness({
        selfUid: SELF_UID,
        openConv: async (cid, ct) => {
          // Refill the store as Phase 4 openConversation would.
          h.store.upsertMessages(cid, ct, remoteRefill, true);
          return remoteRefill;
        },
      });
      seedChannel(h.store, { latest_pts: '500', unread_count: 7 });
      // Pre-seed a stale buffer.
      h.store.upsertMessages(CHANNEL_ID, CHANNEL_TYPE, [
        commitToMessageRecord(commit(100), CHANNEL_ID, CHANNEL_TYPE),
      ], true);

      h.errorQueue.push(ptsErr(SYNC_CHANNEL_RESYNC_REQUIRED, { current_pts: 1234 }));
      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      expect(res.status).toBe('resynced');
      expect(h.openConvCalls).toEqual([{ channel_id: CHANNEL_ID, channel_type: CHANNEL_TYPE }]);
      const after = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(after.latest_pts).toBe('0'); // NOT 1234 — must NOT trust error envelope
      expect(after.server_current_pts).toBe('1234'); // captured for observability
      expect(res.latest_pts_before).toBe('500');
      expect(res.latest_pts_after).toBe('0');

      // Buffer was wiped + refilled by openConversation.
      const buffer = h.store.getMessages(CHANNEL_ID, CHANNEL_TYPE);
      expect(buffer.map((m) => m.server_message_id)).toEqual(['99']);
    });
  });

  describe('Case 7: page cap — 65 pages of has_more=true', () => {
    it('stops at MAX (here forced to 3) and returns synced', async () => {
      const h = newHarness({ selfUid: SELF_UID, maxPages: 3 });
      seedChannel(h.store);
      // Each page returns has_more=true, forcing the loop to hit the cap.
      for (let i = 0; i < 5; i++) {
        h.pageQueue.push(okPage([commit(i * 10 + 1), commit(i * 10 + 2)], 999, true));
      }
      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      expect(res.status).toBe('synced');
      expect(res.pages_fetched).toBe(3);
      expect(h.callsLog).toHaveLength(3);
    });
  });

  describe('Case 8: sender = self → unread does NOT bump', () => {
    it('skips unread bump for own commits regardless of pts', async () => {
      const selfStr = '42';
      const h = newHarness({ selfUid: selfStr });
      seedChannel(h.store, { read_pts: '0', unread_count: 0 });

      h.pageQueue.push(
        okPage(
          [
            commit(1, { sender_id: selfStr }),
            commit(2, { sender_id: selfStr }),
          ],
          2,
        ),
      );
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      const after = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(after.unread_count).toBe(0);
      expect(after.latest_pts).toBe('2'); // still advances
    });
  });

  describe('Case 9: sender = other + pts > read_pts → unread bumps by N', () => {
    it('counts only commits past read_pts from foreign senders', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store, { read_pts: '5', unread_count: 0 });

      h.pageQueue.push(
        okPage(
          [
            commit(3), // pts <= read_pts → skip
            commit(5), // pts == read_pts → skip
            commit(6), // qualifies
            commit(7), // qualifies
          ],
          7,
        ),
      );
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      const after = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(after.unread_count).toBe(2);
    });
  });

  describe('Case 10: re-sync does not double-bump unread', () => {
    it('dedupe-skipped commits do NOT bump even when pts > read_pts', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store, { read_pts: '0', unread_count: 0 });

      // First pass: 3 peer commits past read_pts.
      h.pageQueue.push(okPage([commit(1), commit(2), commit(3)], 3));
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      expect(h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!.unread_count).toBe(3);

      // Second pass: server returns the same 3 commits (e.g. cache had to
      // reissue last_pts for whatever reason). Should be dedupe-skipped.
      h.pageQueue.push(okPage([commit(1), commit(2), commit(3)], 3));
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      expect(h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!.unread_count).toBe(3);
    });
  });

  describe('Case 11: local-echo ACK does NOT bump unread', () => {
    it('ACK swap stays out of the unread tally even with pts > read_pts', async () => {
      const selfStr = '7';
      const h = newHarness({ selfUid: selfStr });
      seedChannel(h.store, { read_pts: '0', unread_count: 0 });

      const pending: MessageRecord = {
        channel_id: CHANNEL_ID,
        channel_type: CHANNEL_TYPE,
        local_message_id: '99',
        from_uid: selfStr,
        message_type: 'text',
        content: 'hi',
        payload: new Uint8Array(),
        timestamp: 1_700_000_000_000,
        status: 'pending',
      };
      h.store.upsertMessage(pending, false);

      h.pageQueue.push(
        okPage(
          [commit(10, { server_msg_id: '200', local_message_id: '99', sender_id: selfStr })],
          10,
        ),
      );
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      const after = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(after.unread_count).toBe(0);
    });
  });

  // ----- Decisions / catastrophic path coverage -----

  describe('20902 SyncFullRebuildRequired → emits L1 event, cache untouched', () => {
    it('returns rebuild_required and emits sync_full_rebuild_required', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store, { latest_pts: '500', unread_count: 9 });
      const seeded = commitToMessageRecord(commit(100), CHANNEL_ID, CHANNEL_TYPE);
      h.store.upsertMessages(CHANNEL_ID, CHANNEL_TYPE, [seeded], true);

      h.errorQueue.push(ptsErr(SYNC_FULL_REBUILD_REQUIRED, { reason: 'eviction' }));
      const res = await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);

      expect(res.status).toBe('rebuild_required');
      expect(res.commits_applied).toBe(0);
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({
        type: 'sync_full_rebuild_required',
        channel_id: CHANNEL_ID,
        channel_type: CHANNEL_TYPE,
        error_code: SYNC_FULL_REBUILD_REQUIRED,
      });
      // Cache untouched.
      const after = h.store.getChannel(CHANNEL_ID, CHANNEL_TYPE)!;
      expect(after.latest_pts).toBe('500');
      expect(after.unread_count).toBe(9);
      expect(h.openConvCalls).toEqual([]);
    });
  });

  describe('per-channel mutex', () => {
    it('returns the same in-flight promise for concurrent syncs of one channel', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store);
      // Block the response until both calls are fired.
      let release!: (resp: GetDifferenceResponse) => void;
      const callDifference = vi.fn<
        [GetDifferenceRequest],
        Promise<GetDifferenceResponse>
      >(() => new Promise((resolve) => (release = resolve)));
      const engine = new SyncEngine({
        db: h.db,
        store: h.store,
        callDifference,
        openConversation: async () => [],
        getCurrentUserId: () => SELF_UID,
        emit: () => {},
        warn: () => {},
      });

      const p1 = engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      const p2 = engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      expect(p1).toBe(p2);
      release(okPage([], 0));
      await p1;
      expect(callDifference).toHaveBeenCalledTimes(1);
    });

    it('releases the mutex slot once a sync completes (next call hits the wire)', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store);
      h.pageQueue.push(okPage([], 0));
      h.pageQueue.push(okPage([], 0));
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      await h.engine.syncChannel(CHANNEL_ID, CHANNEL_TYPE);
      expect(h.callsLog).toHaveLength(2);
    });

    it('different channels run independently (parallel)', async () => {
      const h = newHarness({ selfUid: SELF_UID });
      seedChannel(h.store, { channel_id: '100', channel_type: 1 });
      seedChannel(h.store, { channel_id: '200', channel_type: 1 });
      h.pageQueue.push(okPage([commit(1)], 1));
      h.pageQueue.push(okPage([commit(2)], 2));

      const [a, b] = await Promise.all([
        h.engine.syncChannel('100', 1),
        h.engine.syncChannel('200', 1),
      ]);

      expect(a.commits_applied + b.commits_applied).toBe(2);
      expect(h.callsLog).toHaveLength(2);
      const channelsCalled = new Set(h.callsLog.map((r) => r.channel_id));
      expect(channelsCalled).toEqual(new Set(['100', '200']));
    });
  });
});

describe('commitToMessageRecord', () => {
  it('passes through string ids verbatim and leaves payload empty', () => {
    const c = commit(7, { server_msg_id: '123', local_message_id: '9', sender_id: '42' });
    const rec = commitToMessageRecord(c, '100', 1);
    expect(rec.server_message_id).toBe('123');
    expect(rec.local_message_id).toBe('9');
    expect(rec.pts).toBe('7');
    expect(rec.from_uid).toBe('42');
    expect(rec.payload.length).toBe(0);
    expect(rec.status).toBe('received');
    expect(rec.revoked).toBe(false);
  });

  it('extracts text from object content', () => {
    const c = commit(1, { content: { text: 'hello' } });
    expect(commitToMessageRecord(c, '100', 1).content).toBe('hello');
  });

  it('falls back to JSON.stringify for non-extractable content', () => {
    const c = commit(1, { content: { foo: 'bar' } });
    expect(commitToMessageRecord(c, '100', 1).content).toBe('{"foo":"bar"}');
  });
});
