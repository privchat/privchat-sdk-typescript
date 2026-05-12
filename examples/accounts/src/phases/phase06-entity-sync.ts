// Verify entity/sync_entities for Phase 4's IndexedDB bootstrap dependency.
//
// Phase 4 will call this RPC twice on first authenticate (channel + cursor)
// to populate the local channels table. This phase nails down the exact wire
// shape so the cache code can rely on it without surprises.

import type { MultiAccountManager } from '../account-manager.js';
import type {
  ChannelReadCursorSyncPayload,
  ChannelSyncPayload,
  SyncEntitiesRequest,
  SyncEntitiesResponse,
} from '../rpc-types.js';
import { emptyMetrics, type PhaseResult } from '../types.js';

const ROUTE = 'entity/sync_entities';

export async function phase06_entity_sync(
  mgr: MultiAccountManager,
): Promise<PhaseResult> {
  const start = Date.now();
  const metrics = emptyMetrics();
  const alice = mgr.client('alice');
  const aliceUid = Number(mgr.userId('alice'));

  // ---------- 1. entity_type = "channel" ----------

  const channelResp = await alice.rpcCallTyped<
    SyncEntitiesRequest,
    SyncEntitiesResponse<ChannelSyncPayload>
  >(ROUTE, { entity_type: 'channel', since_version: 0, limit: 100 });
  metrics.rpc_calls += 1;

  // Top-level shape
  if (!Array.isArray(channelResp.items)) {
    metrics.errors.push('channel sync: items is not an array');
  } else {
    metrics.rpc_successes += 1;
  }
  if (typeof channelResp.next_version !== 'number') {
    metrics.errors.push(`channel sync: next_version expected number, got ${typeof channelResp.next_version}`);
  }
  if (typeof channelResp.has_more !== 'boolean') {
    metrics.errors.push(`channel sync: has_more expected boolean, got ${typeof channelResp.has_more}`);
  }

  // After phase02 alice has 2 direct channels (with bob, charlie).
  if (channelResp.items.length < 2) {
    metrics.errors.push(`channel sync: expected ≥ 2 channels for alice, got ${channelResp.items.length}`);
  }

  // Per-item shape (sample the first channel only)
  const firstChannel = channelResp.items[0];
  if (firstChannel) {
    if (typeof firstChannel.entity_id !== 'string') {
      metrics.errors.push(`channel item: entity_id expected string (u64-as-str), got ${typeof firstChannel.entity_id}`);
    }
    if (typeof firstChannel.version !== 'number') {
      metrics.errors.push(`channel item: version expected number, got ${typeof firstChannel.version}`);
    }
    if (typeof firstChannel.deleted !== 'boolean') {
      metrics.errors.push(`channel item: deleted expected boolean, got ${typeof firstChannel.deleted}`);
    }
    if (firstChannel.payload === undefined || firstChannel.payload === null) {
      metrics.errors.push('channel item: payload missing');
    } else {
      const p = firstChannel.payload;
      // channel_id MUST be present (it's the join key for read_cursor lookup)
      if (typeof p.channel_id !== 'number') {
        metrics.errors.push(`channel payload: channel_id expected number, got ${typeof p.channel_id}`);
      }
      // channel_type comes through one of: channel_type | type
      const ct = p.channel_type ?? p.type;
      if (typeof ct !== 'number') {
        metrics.errors.push(`channel payload: channel_type/type expected number, got channel_type=${typeof p.channel_type} type=${typeof p.type}`);
      }
      // unread_count is the headline number for the channel list UI
      if (p.unread_count !== undefined && typeof p.unread_count !== 'number') {
        metrics.errors.push(`channel payload: unread_count expected number|undefined, got ${typeof p.unread_count}`);
      }
      metrics.rpc_successes += 1;
    }
  }

  // ---------- 2. entity_type = "channel_read_cursor" ----------

  const cursorResp = await alice.rpcCallTyped<
    SyncEntitiesRequest,
    SyncEntitiesResponse<ChannelReadCursorSyncPayload>
  >(ROUTE, { entity_type: 'channel_read_cursor', since_version: 0, limit: 100 });
  metrics.rpc_calls += 1;

  if (!Array.isArray(cursorResp.items)) {
    metrics.errors.push('cursor sync: items is not an array');
  } else {
    metrics.rpc_successes += 1;
  }
  if (typeof cursorResp.next_version !== 'number') {
    metrics.errors.push(`cursor sync: next_version expected number, got ${typeof cursorResp.next_version}`);
  }

  // Cursor count is permissive: server may return 0 (no read marks yet) or
  // one per channel. Whatever's there must have the right shape.
  for (const item of cursorResp.items) {
    if (typeof item.entity_id !== 'string') {
      metrics.errors.push('cursor item: entity_id expected string (channel_id:reader_id)');
    } else if (!item.entity_id.includes(':')) {
      metrics.errors.push(`cursor item: entity_id expected "channel_id:reader_id" form, got "${item.entity_id}"`);
    }
    if (item.payload === undefined || item.payload === null) {
      metrics.errors.push('cursor item: payload missing');
      continue;
    }
    const p = item.payload;
    if (typeof p.channel_id !== 'number') {
      metrics.errors.push(`cursor payload: channel_id expected number, got ${typeof p.channel_id}`);
    }
    if (typeof p.reader_id !== 'number') {
      metrics.errors.push(`cursor payload: reader_id expected number, got ${typeof p.reader_id}`);
    } else if (p.reader_id !== aliceUid) {
      metrics.errors.push(`cursor payload: reader_id ${p.reader_id} does not match alice uid ${aliceUid}`);
    }
    if (p.last_read_pts !== undefined && typeof p.last_read_pts !== 'number') {
      metrics.errors.push(`cursor payload: last_read_pts expected number|undefined, got ${typeof p.last_read_pts}`);
    }
  }
  if (cursorResp.items.length > 0) metrics.rpc_successes += 1;

  // ---------- 3. since_version pagination contract ----------
  // Re-query with since_version = next_version returned above.
  // Should return 0 items and has_more=false (we just consumed everything).
  const incremental = await alice.rpcCallTyped<
    SyncEntitiesRequest,
    SyncEntitiesResponse<ChannelSyncPayload>
  >(ROUTE, {
    entity_type: 'channel',
    since_version: channelResp.next_version,
    limit: 100,
  });
  metrics.rpc_calls += 1;
  if (incremental.items.length === 0 && incremental.has_more === false) {
    metrics.rpc_successes += 1;
  } else {
    metrics.errors.push(
      `incremental sync from next_version=${channelResp.next_version} expected empty page, got items=${incremental.items.length} has_more=${incremental.has_more}`,
    );
  }

  return {
    phase_name: 'entity-sync',
    success: metrics.errors.length === 0,
    duration_ms: Date.now() - start,
    details: `channel(${channelResp.items.length}) + cursor(${cursorResp.items.length}) bootstrap shapes verified; pagination contract holds`,
    metrics,
  };
}
