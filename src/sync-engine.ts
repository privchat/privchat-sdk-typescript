// Phase 5B-1 sync engine. Per-channel gap-fill against
// `sync/get_difference`. See `docs/PHASE5B_SYNC_ENGINE_PLAN.md` for the
// full state machine, decisions, and merge invariants — this file is the
// implementation, not the design.
//
// Boundaries:
//   - Wire encoding lives ONLY in `getChannelDifference` (one place to
//     migrate when server u64-as-string ships).
//   - All snowflake / pts ids cross the engine boundary as `IdString`
//     (decimal strings); BigInt comparisons are the ONLY numeric ops.
//   - Identity is the stable `id`; network lookups go through
//     local_message_id (5B-0 invariant). The engine never invents a
//     `message_id` field on MessageRecord.
//   - Unread bumps count ONLY commits that hit the "newly inserted"
//     branch — dedupe-skips and ACK-swap transitions do not bump.
//
// Out of scope for 5B-1c: reconnect wiring (5B-1d), accounts E2E (5B-1e).

import { parseRpcJson } from './codec/safe-json.js';
import { encodeMessagePayloadEnvelope } from './codec/payload.js';
import { resolveCanonicalTimelineEvent } from './codec/timeline.js';
import { contentTypeFromWireTag } from './content-type.js';
import {
  clearChannelMessages as cacheClearChannelMessages,
  applyAck,
  canonicalFromSyncCommit,
  getChannelOrderMode,
  getSyncState as cacheGetSyncState,
  upsertMessages as cacheUpsertMessages,
  upsertSyncState as cacheUpsertSyncState,
  CacheDB,
  MessageStore,
  nextLocalMessageRecordId,
  type ChannelRecord,
  type MessageRecord,
} from './cache/index.js';
import type {
  GetDifferenceRequest,
  GetDifferenceResponse,
  ServerCommit,
} from './api-types.js';
import type { SdkEvent } from './events.js';

/** Row shape as persisted (`MessageRecord` + its derived `sort_key`). */
type StoredMessageRow = MessageRecord & { sort_key: string };

/** Drop the storage-only `sort_key`; it is derived, never published. */
function stripRecordKey(row: StoredMessageRow): MessageRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sort_key: _ignored, ...rest } = row;
  return rest;
}

/** Everything one page transaction committed, for publication afterwards. */
interface PageCommit {
  newlyInserted: number;
  ackSwaps: Array<{ localKey: string; acked: MessageRecord }>;
  upserts: MessageRecord[];
  nextChannel?: ChannelRecord;
}

// ----- Server-side error codes (privchat-protocol/src/error_code.rs) -----

/** Channel-scoped resync required: stale or non-contiguous cursor. */
export const SYNC_CHANNEL_RESYNC_REQUIRED = 20900;
/** Catastrophic mismatch: SDK does not auto-recover; host must decide. */
export const SYNC_FULL_REBUILD_REQUIRED = 20902;

/** Wire route. Co-located with the engine because there's only one caller. */
export const SYNC_GET_DIFFERENCE_ROUTE = 'sync/get_difference';

/** Hard cap on pages per syncChannel pass. Larger gaps signal that the
 *  channel needs a full resync, not a longer loop. Mirrors the Rust
 *  SDK's `resume_channel_difference` cap. */
export const MAX_SYNC_PAGES = 64;

/** Default page size — matches the server's default (`limit` is optional
 *  on the wire; server falls back to 100 when absent). */
const DEFAULT_PAGE_LIMIT = 100;

// ----- Public result shape -----

export type SyncStatus =
  | 'current'              // Cache already at server pts; nothing fetched.
  | 'synced'               // Commits fetched + applied successfully.
  | 'resynced'             // Server demanded resync (20900); recovered via openConversation.
  | 'rebuild_required';    // 20902 from server; host must take over.

export interface SyncResult {
  channel_id: string;
  channel_type: number;
  status: SyncStatus;
  /** Commits that were newly inserted into the cache (excludes dedupe-skips
   *  and ACK-swap transitions). 0 for `current` / `rebuild_required`. */
  commits_applied: number;
  /** Number of `sync/get_difference` round-trips. Includes the call that
   *  detected `current` (returns 1 in that case). */
  pages_fetched: number;
  latest_pts_before: string;
  latest_pts_after: string;
}

// ----- Server-error handle -----

/**
 * Minimum surface the engine needs to inspect an RPC failure:
 *   - `code` to classify (20900 / 20902 / other)
 *   - `message`, `dataBytes` for diagnostics + `current_pts` extraction
 *
 * The engine's caller must catch its `rpcCallTyped` invocations and surface
 * the underlying RpcResponse via this shape so the engine stays decoupled
 * from the Error class hierarchy in client.ts.
 */
export interface SyncRpcErrorBody {
  code: number;
  message: string;
  dataBytes?: Uint8Array;
}

export class SyncRpcError extends Error {
  readonly body: SyncRpcErrorBody;
  constructor(body: SyncRpcErrorBody) {
    super(`sync rpc failed: code=${body.code} message=${body.message}`);
    this.name = 'SyncRpcError';
    this.body = body;
  }
}

// ----- Engine deps -----

export interface SyncEngineDeps {
  db: CacheDB;
  store: MessageStore;
  /** Routed RPC. Throws SyncRpcError on non-zero `code` (caller adapts
   *  the SDK's RpcError → SyncRpcError). */
  callDifference: (req: GetDifferenceRequest) => Promise<GetDifferenceResponse>;
  /** Re-hydrate the cache from the authoritative history wire after a
   *  20900 resync. Same signature as `PrivchatClient.openConversation`. */
  openConversation: (
    channel_id: string,
    channel_type: number,
  ) => Promise<MessageRecord[]>;
  /** Current authenticated user_id (string). Used for the "self ≠ sender"
   *  branch of the unread-count bump. Returns undefined when the SDK
   *  hasn't authenticated yet — engine then conservatively treats every
   *  commit as foreign for unread purposes. */
  getCurrentUserId: () => string | undefined;
  /** Emit on the L1 event bus. Engine uses this only for
   *  `sync_full_rebuild_required`. */
  emit: (event: SdkEvent) => void;
  /** Page size override (tests). Defaults to 100. */
  pageLimit?: number;
  /** Max pages override (tests). Defaults to MAX_SYNC_PAGES. */
  maxPages?: number;
  /** Logger sink (tests / host app). Defaults to console.warn. */
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export class SyncEngine {
  private readonly inFlight = new Map<string, Promise<SyncResult>>();
  private readonly deps: Required<
    Pick<SyncEngineDeps, 'pageLimit' | 'maxPages' | 'warn'>
  > &
    Omit<SyncEngineDeps, 'pageLimit' | 'maxPages' | 'warn'>;

  constructor(deps: SyncEngineDeps) {
    this.deps = {
      ...deps,
      pageLimit: deps.pageLimit ?? DEFAULT_PAGE_LIMIT,
      maxPages: deps.maxPages ?? MAX_SYNC_PAGES,
      warn:
        deps.warn ??
        ((msg, ctx) => {
          // eslint-disable-next-line no-console
          console.warn(`[privchat:sync] ${msg}`, ctx ?? {});
        }),
    };
  }

  /**
   * Public entry. Per-channel serialized: a second concurrent call against
   * the same `(channel_id, channel_type)` returns the in-flight promise.
   * Different channels run in parallel.
   */
  syncChannel(channel_id: string, channel_type: number): Promise<SyncResult> {
    const key = mutexKey(channel_id, channel_type);
    const inFlight = this.inFlight.get(key);
    if (inFlight) return inFlight;
    const promise = this.runSync(channel_id, channel_type).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  // ----- Internal: orchestration -----

  private async runSync(
    channel_id: string,
    channel_type: number,
  ): Promise<SyncResult> {
    const before = this.resolveCursor(channel_id, channel_type);
    const cursor = { value: before };
    let pages = 0;
    let appliedTotal = 0;

    while (pages < this.deps.maxPages) {
      pages += 1;
      let resp: GetDifferenceResponse;
      try {
        resp = await this.deps.callDifference({
          channel_id,
          channel_type,
          last_pts: cursor.value,
          limit: this.deps.pageLimit,
        });
      } catch (e) {
        if (e instanceof SyncRpcError) {
          if (e.body.code === SYNC_CHANNEL_RESYNC_REQUIRED) {
            return this.handleResync(channel_id, channel_type, e.body, before, pages);
          }
          if (e.body.code === SYNC_FULL_REBUILD_REQUIRED) {
            this.deps.emit({
              type: 'sync_full_rebuild_required',
              channel_id,
              channel_type,
              error_code: e.body.code,
              message: e.body.message,
            });
            return {
              channel_id,
              channel_type,
              status: 'rebuild_required',
              commits_applied: 0,
              pages_fetched: pages,
              latest_pts_before: before,
              latest_pts_after: before,
            };
          }
        }
        throw e;
      }

      // Empty + !has_more on the first page = "already current".
      if (resp.commits.length === 0) {
        if (!resp.has_more) {
          // Nothing to apply — only the observed server pts (observability
          // + cursor seed). Still one transaction, same reason as a real
          // page: cursor and projection are one fact.
          await this.persistEmptyPage(
            channel_id,
            channel_type,
            resp.current_pts,
            cursor.value,
          );
          return {
            channel_id,
            channel_type,
            status: appliedTotal > 0 ? 'synced' : 'current',
            commits_applied: appliedTotal,
            pages_fetched: pages,
            latest_pts_before: before,
            latest_pts_after: this.snapshotLatestPts(channel_id, channel_type, before),
          };
        }
        // has_more=true with empty commits is anomalous; bail to avoid spin.
        this.deps.warn('sync page returned empty commits with has_more=true', {
          channel_id,
          channel_type,
          cursor: cursor.value,
        });
        break;
      }

      // The page — rows, channel projection, cursor — commits atomically
      // inside `mergeCommits`. A failure leaves the cursor untouched, so
      // the next attempt re-reads this page rather than skipping it.
      const pageCursor = resp.commits[resp.commits.length - 1]!.pts;
      const applied = await this.mergeCommits(
        channel_id,
        channel_type,
        resp.commits,
        pageCursor,
        resp.current_pts,
      );
      appliedTotal += applied;
      cursor.value = pageCursor;

      if (!resp.has_more) {
        return {
          channel_id,
          channel_type,
          status: 'synced',
          commits_applied: appliedTotal,
          pages_fetched: pages,
          latest_pts_before: before,
          latest_pts_after: this.snapshotLatestPts(channel_id, channel_type, before),
        };
      }
    }

    // Page cap exhausted with has_more still true.
    this.deps.warn('sync hit MAX_SYNC_PAGES; channel may need a full resync', {
      channel_id,
      channel_type,
      pages,
    });
    return {
      channel_id,
      channel_type,
      status: 'synced',
      commits_applied: appliedTotal,
      pages_fetched: pages,
      latest_pts_before: before,
      latest_pts_after: this.snapshotLatestPts(channel_id, channel_type, before),
    };
  }

  // ----- Internal: cursor + persistence -----

  private resolveCursor(channel_id: string, channel_type: number): string {
    const channel = this.deps.store.getChannel(channel_id, channel_type);
    const fromMem = channel?.latest_pts ?? '0';
    // sync_state lives in IndexedDB only; we read it lazily on the first
    // pass per channel-process lifetime via an async path that runs
    // BEFORE the loop starts. To keep runSync synchronous in cursor
    // resolution, we consult only the in-memory ChannelRecord here; the
    // sync_state.latest_pts is opportunistically read at startup by the
    // host app (via bootstrapChannels' future incarnation) and folded
    // back into ChannelRecord. For now: in-memory record is the cursor.
    return fromMem;
  }

  private snapshotLatestPts(
    channel_id: string,
    channel_type: number,
    fallback: string,
  ): string {
    return (
      this.deps.store.getChannel(channel_id, channel_type)?.latest_pts ??
      fallback
    );
  }

  /**
   * Commit an empty page: no rows changed, so only the cursor seed and the
   * channel's observed `server_current_pts` move. Memory is published after
   * the transaction, exactly as for a page carrying commits.
   */
  private async persistEmptyPage(
    channel_id: string,
    channel_type: number,
    server_current_pts: string,
    cursor: string,
  ): Promise<void> {
    const { db, store } = this.deps;
    const channel = store.getChannel(channel_id, channel_type);
    const nextChannel =
      channel && channel.server_current_pts !== server_current_pts
        ? { ...channel, server_current_pts }
        : undefined;
    const previous = await cacheGetSyncState(db, channel_id, channel_type);

    await db.transaction('rw', db.channels, db.sync_state, async () => {
      if (nextChannel !== undefined) {
        await db.channels.put(nextChannel);
      }
      await cacheUpsertSyncState(db, {
        channel_id,
        channel_type,
        min_loaded_at: previous?.min_loaded_at,
        max_loaded_at: previous?.max_loaded_at,
        latest_pts: channel?.latest_pts ?? cursor,
        last_sync_at: Date.now(),
      });
    });

    if (nextChannel !== undefined) store.upsertChannel(nextChannel);
  }

  // ----- Internal: 20900 resync recovery -----

  private async handleResync(
    channel_id: string,
    channel_type: number,
    err: SyncRpcErrorBody,
    latest_pts_before: string,
    pages: number,
  ): Promise<SyncResult> {
    // 1. Drop in-memory buffer (emits removed=[allKeys]).
    this.deps.store.clearBuffer(channel_id, channel_type);

    // 2. Reset latest_pts to "0" on the channel record (if present).
    //    Do NOT trust the error envelope's current_pts as a substitute
    //    for the canonical-merge advance — see PHASE5B_SYNC_ENGINE_PLAN.md
    //    rationale on why latest_pts must come from push / sync commits
    //    only.
    const channel = this.deps.store.getChannel(channel_id, channel_type);
    if (channel) {
      const resetPts: ChannelRecord = {
        ...channel,
        latest_pts: '0',
      };
      this.deps.store.upsertChannel(resetPts);
      void this.deps.db.channels.put(resetPts).catch(() => {});
    }

    // 3. Reset SyncStateRecord.latest_pts to "0".
    const existing = await cacheGetSyncState(
      this.deps.db,
      channel_id,
      channel_type,
    ).catch(() => undefined);
    await cacheUpsertSyncState(this.deps.db, {
      channel_id,
      channel_type,
      min_loaded_at: existing?.min_loaded_at,
      max_loaded_at: existing?.max_loaded_at,
      latest_pts: '0',
      last_sync_at: Date.now(),
    }).catch(() => {});

    // 4. Drop persisted messages for this channel.
    await cacheClearChannelMessages(this.deps.db, channel_id, channel_type).catch(
      () => {},
    );

    // 5. Re-hydrate via Phase 4 openConversation. This emits cached
    //    (now empty) → remote (latest history window). It does NOT lift
    //    latest_pts (history wire has no pts).
    try {
      await this.deps.openConversation(channel_id, channel_type);
    } catch (e) {
      this.deps.warn('resync: openConversation failed', {
        channel_id,
        channel_type,
        error: stringifyErr(e),
      });
    }

    // 6. Stash server_current_pts as observability hint (if present in
    //    error envelope). Decoupled from latest_pts on purpose.
    const serverCurrentPts = parseCurrentPts(err.dataBytes);
    if (serverCurrentPts !== undefined) {
      const after = this.deps.store.getChannel(channel_id, channel_type);
      if (after) {
        const withHint: ChannelRecord = {
          ...after,
          server_current_pts: serverCurrentPts,
        };
        this.deps.store.upsertChannel(withHint);
        void this.deps.db.channels.put(withHint).catch(() => {});
      }
    }

    return {
      channel_id,
      channel_type,
      status: 'resynced',
      commits_applied: 0,
      pages_fetched: pages,
      latest_pts_before,
      latest_pts_after:
        this.deps.store.getChannel(channel_id, channel_type)?.latest_pts ?? '0',
    };
  }

  // ----- Internal: per-page merge -----

  /** Returns the count of newly-inserted commits (drives unread bump
   *  qualification + the SyncResult.commits_applied tally). */
  private async mergeCommits(
    channel_id: string,
    channel_type: number,
    commits: ServerCommit[],
    /** Highest pts in this page — the cursor the caller wants to move to. */
    cursor: string,
    server_current_pts: string,
  ): Promise<number> {
    const { store, db } = this.deps;
    const currentUserId = this.deps.getCurrentUserId();

    // ---- Page commit ----
    //
    // Rows, channel projection and cursor are one fact — "the cache has
    // consumed this page" — so they commit together or not at all. Writing
    // them separately lets the cursor advance past commits that never
    // reached the database, and the next sync starts after them.
    //
    // Every input to the decision is read from disk INSIDE the transaction.
    // Deriving unread/latest_pts from the in-memory snapshot taken before
    // the transaction is not safe with more than one tab open on the same
    // account: both would read `unread=5`, both would write `6`, and one
    // increment silently disappears. IndexedDB serialises the writes, not
    // the stale reads that produced them. The same applies to dedup — a row
    // another tab already stored is only visible on disk.
    const page = await db.transaction(
      'rw',
      db.messages_v2,
      db.channels,
      db.sync_state,
      db.cache_metadata,
      async (): Promise<PageCommit> => {
        // Disk is authoritative — that is what makes concurrent tabs safe.
        // The memory fallback covers the window where a channel exists in
        // this process but has not been written yet (a push can create one
        // before it is persisted); without it the page would silently drop
        // the unread bump and pts advance for that channel. Committing the
        // projection below materialises the row, so the fallback stops
        // applying from the next page onwards.
        const channelBefore =
          (await db.channels.get(channel_id)) ?? store.getChannel(channel_id, channel_type);
        const previousSyncState = await cacheGetSyncState(db, channel_id, channel_type);
        const readPts = channelBefore?.read_pts ?? '0';

        // Only the keys this page can touch — bounded by page size, so the
        // read stays cheap regardless of how long the conversation is.
        // Look rows up by the two network identities. `id` cannot be used
        // here: a commit arriving from the wire has no local id yet, and the
        // whole point of the lookup is to find whether a row for that
        // message already exists.
        const serverIds = [...new Set(commits.map((c) => String(c.server_msg_id)))];
        const localIds = [
          ...new Set(
            commits
              .filter((c) => c.local_message_id !== undefined)
              .map((c) => String(c.local_message_id)),
          ),
        ];
        const onDisk = new Map<string, StoredMessageRow>();
        for (const sid of serverIds) {
          const row = await db.messages_v2
            .where('[channel_id+server_message_id]')
            .equals([channel_id, sid])
            .first();
          if (row !== undefined) onDisk.set(`s:${sid}`, row);
        }
        for (const lid of localIds) {
          const row = await db.messages_v2
            .where('[channel_id+local_message_id]')
            .equals([channel_id, lid])
            .first();
          if (row !== undefined) onDisk.set(`l:${lid}`, row);
        }

        let newlyInserted = 0;
        let unreadBump = 0;
        let maxPtsSeen: bigint = BigInt(channelBefore?.latest_pts ?? '0');
        let maxTimestampSeen = channelBefore?.updated_at ?? 0;
        const toUpsert: MessageRecord[] = [];
        const ackSwaps: Array<{ localKey: string; acked: MessageRecord }> = [];

        for (const commit of commits) {
          const targetKey = `s:${commit.server_msg_id}`;
          const next = commitToMessageRecord(commit, channel_id, channel_type, currentUserId);

          const ptsBig = BigInt(commit.pts);
          if (ptsBig > maxPtsSeen) maxPtsSeen = ptsBig;
          if (next.timestamp > maxTimestampSeen) maxTimestampSeen = next.timestamp;

          // ACK swap candidate: the server commit echoes our
          // local_message_id, so it is our own message coming back. The
          // pending row is keyed `l:<local_message_id>`.
          //
          // This must run even when `targetKey` already exists: that case is
          // the self-push landing before the ACK. Skipping the swap there
          // leaves the pending row in place forever, so the message shows
          // twice, one copy stuck at "sending".
          if (commit.local_message_id !== undefined) {
            const localKey = `l:${commit.local_message_id}`;
            const pending = onDisk.get(localKey);
            if (pending && pending.status === 'pending') {
              const acked: MessageRecord = {
                ...next,
                // Identity is the pending row's, not the one minted for the
                // commit: the ACK updates that row, it does not create one.
                id: pending.id,
                local_order_seq: pending.local_order_seq,
                local_message_id: pending.local_message_id,
                status: 'sent',
                payload: pending.payload,
              };
              ackSwaps.push({ localKey, acked });
              onDisk.delete(localKey);
              // ACK swap is a transition, NOT a newly-inserted row → no unread.
              continue;
            }
          }

          const existing = onDisk.get(targetKey);
          if (existing) {
            if (messageEquals(existing, next)) {
              // Dedupe-skip: already present byte-equal. No write, no patch,
              // no unread bump.
              continue;
            }
            // Content drift: server-side mutation since we last saw this row
            // (e.g. revoke). Update; does NOT count as newly inserted.
            toUpsert.push(next);
            continue;
          }

          toUpsert.push(next);
          newlyInserted += 1;

          // Unread bump qualification (spec § mergeCommits step 5).
          const isOwnMessage =
            currentUserId !== undefined && commit.sender_id === currentUserId;
          const ptsAboveRead = BigInt(commit.pts) > BigInt(readPts);
          if (!isOwnMessage && ptsAboveRead && next.revoked !== true) {
            unreadBump += 1;
          }
        }

        // Write rows first, and keep what the store actually persisted: the
        // write may have adopted the id and order already on disk. Publishing
        // our own copies instead would put a different id in memory than in
        // the database — the identity split this mechanism exists to
        // prevent.
        const durableAcked: Array<{ localKey: string; acked: MessageRecord }> = [];
        for (const { localKey, acked } of ackSwaps) {
          const stored = await applyAck(db, acked);
          durableAcked.push({ localKey: stored.id, acked: stored });
        }
        await cacheUpsertMessages(db, toUpsert);

        // Channel projection, derived from the row read inside this
        // transaction rather than from the memory snapshot.
        let nextChannel: ChannelRecord | undefined;
        if (channelBefore) {
          let candidate: ChannelRecord = channelBefore;
          let mutated = false;
          if (maxPtsSeen > BigInt(channelBefore.latest_pts)) {
            candidate = { ...candidate, latest_pts: maxPtsSeen.toString() };
            mutated = true;
          }
          if (maxTimestampSeen > channelBefore.updated_at) {
            candidate = { ...candidate, updated_at: maxTimestampSeen };
            mutated = true;
          }
          if (unreadBump > 0) {
            candidate = {
              ...candidate,
              unread_count: channelBefore.unread_count + unreadBump,
            };
            mutated = true;
          }
          if (channelBefore.server_current_pts !== server_current_pts) {
            candidate = { ...candidate, server_current_pts };
            mutated = true;
          }
          if (mutated) {
            nextChannel = candidate;
            await db.channels.put(candidate);
          }
        }

        // Cursor last: mirrors channel.latest_pts so a cold cache can seed
        // itself. `cursor` is the highest applied pts of this page.
        await cacheUpsertSyncState(db, {
          channel_id,
          channel_type,
          min_loaded_at: previousSyncState?.min_loaded_at,
          max_loaded_at: previousSyncState?.max_loaded_at,
          latest_pts: nextChannel?.latest_pts ?? channelBefore?.latest_pts ?? cursor,
          last_sync_at: Date.now(),
        });

        // Re-read every row this page touched, and publish THAT.
        //
        // Not just the rows we wrote: when another tab already stored a
        // commit, this pass finds it byte-equal and writes nothing — but
        // that says nothing about whether THIS process has it in memory.
        // Publishing only our own writes would converge the database and
        // leave this tab's timeline missing the message. The same applies
        // to the channel: another tab may have advanced it further than we
        // did, and memory should reflect the durable truth either way.
        const finalRows: StoredMessageRow[] = [];
        for (const sid of serverIds) {
          const row = await db.messages_v2
            .where('[channel_id+server_message_id]')
            .equals([channel_id, sid])
            .first();
          if (row !== undefined) finalRows.push(row);
        }
        const authoritative = finalRows.map(stripRecordKey);
        const finalChannel = (await db.channels.get(channel_id)) ?? nextChannel;

        return {
          newlyInserted,
          ackSwaps: durableAcked,
          upserts: authoritative,
          nextChannel: finalChannel,
        };
      },
    );

    // ---- Publication, after the page is durable ----
    //
    // Strictly what is on disk: memory shows what a reload would show.
    // Sync fills pts gaps in, which is what brings a degraded channel back
    // to pts order; publish the mode before the rows so the buffer is sorted
    // under the same one the keys were rewritten with.
    store.setChannelOrderMode(channel_id, await getChannelOrderMode(db, channel_id));
    for (const { localKey, acked } of page.ackSwaps) {
      store.replaceMessage(channel_id, channel_type, localKey, acked, true);
    }
    if (page.upserts.length > 0) {
      // Single patch from MessageStore (already dedupes by identity).
      store.upsertMessages(channel_id, channel_type, page.upserts, true);
    }
    if (page.nextChannel !== undefined) {
      store.upsertChannel(page.nextChannel);
    }

    return page.newlyInserted;
  }
}

// ----- Helpers -----

function mutexKey(channel_id: string, _channel_type: number): string {
  // Conversation identity is the channel_id alone; see message-store.ts.
  return channel_id;
}

/**
 * Convert a `sync/get_difference` commit into a cache `MessageRecord`.
 * Mirrors `historicalMessageToRecord` (Phase 4) and `pushToMessageRecord`
 * (Phase 4 push) at the same fidelity — payload bytes are empty because
 * the JSON wire carries parsed `content`, not raw FlatBuffers payload.
 */
export function commitToMessageRecord(
  commit: ServerCommit,
  channel_id: string,
  channel_type: number,
  selfUid?: string,
): MessageRecord {
  const resolved = resolveCanonicalTimelineEvent(commit);
  const canonical =
    resolved.source === 'canonical' && resolved.event?.type === 'new_message'
      ? resolved.event
      : undefined;
  // Multi-device: `sync/get_difference` replays OUR own messages (sent from
  // another device) into this client. Those must land as 'sent', not
  // 'received' — a self row with status 'received' renders as the bogus
  // "received?" delivery label and reads as a peer message.
  const isOwn = selfUid !== undefined && commit.sender_id === selfUid;
  // 媒体 metadata 必须随 sync 补洞消息进入 payload（与 realtime push / history 一致），否则
  // 离线回来 / 断线补洞 / 历史滚动的媒体消息在 Web 退化成 [图片]/[文件]。server 已把 commit
  // content 规范成 {content, metadata}（见 sync_commit_content_from_parsed），这里若带 metadata
  // 就原样编码进 payload，让 decodeMediaMetadata 解码。
  const c = commit.content;
  const payload = canonical
    ? encodeMessagePayloadEnvelope(canonical.payload)
    : typeof c === 'object' && c !== null && 'metadata' in c
      ? new TextEncoder().encode(JSON.stringify(c))
      : new Uint8Array();
  // 经 canonical adapter：metadata 提取与时间归一与 push / history / send-ack 同一
  // 份实现，也正是门禁测试调用的那一份。本地部分只剩 id 与 sent/received 判定。
  const inbound = canonicalFromSyncCommit({
    server_message_id: commit.server_msg_id,
    local_message_id: commit.local_message_id,
    channel_id,
    channel_type,
    from_uid: commit.sender_id,
    message_type: canonical
      ? contentTypeFromWireTag(canonical.message_type)
      : commit.message_type,
    content: canonical?.payload.content ?? extractContent(commit.content),
    payload,
    pts: commit.pts,
    sent_at_ms: commit.server_timestamp,
  });
  return {
    id: nextLocalMessageRecordId(),
    channel_id: inbound.channel_id,
    channel_type: inbound.channel_type,
    server_message_id: inbound.server_message_id,
    local_message_id: inbound.local_message_id,
    pts: inbound.pts,
    from_uid: inbound.from_uid,
    message_type: inbound.message_type,
    content: inbound.content,
    payload: inbound.payload,
    timestamp: inbound.sent_at_ms,
    status: isOwn ? 'sent' : 'received',
    revoked: inbound.revoked,
  };
}

/**
 * Pull a display string out of the commit's JSON `content`. Mirrors the
 * server-side `normalize_submit_payload` extractor:
 *   - string → use verbatim
 *   - object with `text` field → take `text`
 *   - object with `content` field → take `content`
 *   - fallback → JSON.stringify
 */
function extractContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
  }
  return JSON.stringify(value);
}

/**
 * Best-effort extraction of `current_pts` from a 20900 error envelope's
 * `data` bytes. Server may or may not include it; treat as optional. The
 * field, if present, lives under the same key as the success response.
 */
function parseCurrentPts(data: Uint8Array | undefined): string | undefined {
  if (!data || data.length === 0) return undefined;
  try {
    // Lossless parse — `current_pts` is a u64 counter; above 2^53 a plain
    // JSON.parse would round it before the string branch below runs.
    const json = parseRpcJson<Record<string, unknown>>(
      new TextDecoder().decode(data),
    );
    const cp = json['current_pts'];
    if (typeof cp === 'number') return String(cp);
    if (typeof cp === 'string') return cp;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Defensive equality: only the fields that matter for "is this the same
 * commit" decision. Excludes payload (sync rows always have empty
 * payload) and revoked (handled via content-drift path explicitly).
 */
function messageEquals(a: MessageRecord, b: MessageRecord): boolean {
  return (
    a.server_message_id === b.server_message_id &&
    a.pts === b.pts &&
    a.from_uid === b.from_uid &&
    a.message_type === b.message_type &&
    a.content === b.content &&
    a.timestamp === b.timestamp &&
    a.status === b.status &&
    (a.revoked ?? false) === (b.revoked ?? false)
  );
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
