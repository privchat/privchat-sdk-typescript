// L1 strong-typed event surface, mirroring `SDK_EVENT_SURFACE_AND_API_SHAPE_SPEC`.
//
// Discriminated union by `type`. Every event carries a monotonically
// increasing `sequence_id` and a `timestamp_ms` so consumers can:
//   - replay missed events via `events_since(sequence_id, limit)`
//   - cold-start by `recent_events(limit)`
//
// L1 events are FACTS produced by SDK / transport. L2 (collaboration
// requests like NotificationIntentRaised) and L3 (aggregated state
// flows) are the consumer's responsibility — not emitted from the SDK
// in this phase.
//
// The web/online-only TS SDK can only TRIGGER a subset of the spec'd
// L1 events today (no local store / outbound queue / recovery engine),
// but the enum is complete so consumers can write exhaustive switches
// that stay valid as more sources come online.

import type { PongResponse } from './codec/ping.js';
import type { PushBatchRequest, PushMessageRequest } from './codec/push.js';

/** Internal SDK connection lifecycle. Mirrors Rust `ConnectionState`. */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authenticating'
  | 'authenticated'
  | 'reconnecting'
  | 'closing';

/**
 * Reason an authenticate attempt failed in a way the business layer
 * needs to react to. Mirrors Rust `AuthErrorKind` for the auth-expired
 * path.
 */
export type AuthExpiredReason = 'recoverable' | 'terminal';

// ----- L1 event variants -----

export interface ConnectionStateChangedEvent {
  type: 'connection_state_changed';
  state: ConnectionState;
  /** Optional context for the transition — e.g. the error that pushed us into reconnecting. */
  reason?: string;
}

export interface MessageReceivedEvent {
  type: 'message_received';
  message: PushMessageRequest;
}

export interface MessageBatchReceivedEvent {
  type: 'message_batch_received';
  batch: PushBatchRequest;
}

export interface PongReceivedEvent {
  type: 'pong_received';
  pong: PongResponse;
}

/**
 * Auth credential is expired or revoked. Spec MUST: SDK does not auto-refresh —
 * business layer catches this and decides (refreshAccessToken vs force re-login).
 */
export interface AuthExpiredEvent {
  type: 'auth_expired';
  reason: AuthExpiredReason;
  /** Numeric error code (10000 / 10002 = recoverable; 10001 / 10003..10010 = terminal). */
  error_code: number;
  message?: string;
}

/**
 * Auth-refresh coordinator lifecycle (debug/log). Emitted by the
 * SDK-owned refresh flow: when a recoverable auth failure (expired access
 * token) triggers an injected `refreshAuth` call. Web's only HARD
 * dependency is `session_expired`; these three are for diagnostics.
 */
export interface AuthRefreshStartedEvent {
  type: 'auth_refresh_started';
  /** Which path hit the expiry — initial/explicit auth vs auto-reconnect replay. */
  reason: 'token_expired' | 'auth_failed_reconnect';
}
export interface AuthRefreshSucceededEvent {
  type: 'auth_refresh_succeeded';
  reason: 'token_expired' | 'auth_failed_reconnect';
}
export interface AuthRefreshFailedEvent {
  type: 'auth_refresh_failed';
  reason: 'token_expired' | 'auth_failed_reconnect';
  error_code?: number;
  message?: string;
}

/**
 * Terminal auth state: refresh is impossible or was rejected (refresh
 * token expired/revoked, platform 401/403, or no refresh configured for a
 * terminal failure). Fired AT MOST ONCE per client (idempotent). The host
 * app turns this into a "session expired, please log in again" UX. Distinct
 * from `auth_expired` (which also fires for recoverable cases the SDK then
 * silently refreshes).
 */
export interface SessionExpiredEvent {
  type: 'session_expired';
  error_code?: number;
  message?: string;
}

/**
 * Catastrophic sync state mismatch — server rejected even a per-channel
 * resync (typically `SyncFullRebuildRequired`, code 20902). The SDK does
 * NOT auto-wipe local state; the host application must decide whether to
 * clear the cache, force a re-bootstrap, or surface a recovery UX.
 *
 * Phase 5B-1 only emits this when the engine receives 20902 from
 * `sync/get_difference`. Future phases may broaden the trigger surface.
 */
export interface SyncFullRebuildRequiredEvent {
  type: 'sync_full_rebuild_required';
  channel_id: string;
  channel_type: number;
  /** Numeric error code from the server envelope (20902 in the
   *  canonical case; other codes possible if server semantics evolve). */
  error_code: number;
  message?: string;
}

/**
 * Per-entry transition signal for the persistent outbox (Phase 5C).
 * Fires for every state change including the transient outcomes
 * (`'sent'` / `'discarded'`) where the outbox row is deleted at/before
 * emit. Snapshot consumers (`observeOutbox`) get a full snapshot on
 * each transition; this event stream is for hosts that want push-style
 * granularity (status indicators, animations, debug logs).
 */
export interface OutboxStateChangedEvent {
  type: 'outbox_state_changed';
  /** Outbox row identity. Equals `local_message_id` in 5C. */
  outbox_id: string;
  local_message_id: string;
  channel_id: string;
  channel_type: number;
  /** Five-state surface — `pending` / `sending` / `failed` are
   *  persisted; `sent` / `discarded` are transient (the row is gone
   *  by the time this event fires). */
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';
  /** Populated for `'sent'`. */
  server_message_id?: string;
  /** Populated for `'failed'`. Free-form; prefix discriminates
   *  `transient: ...` from `rejected: code=...`. */
  last_error?: string;
}

/**
 * Fires once whenever the outbox transitions from non-empty to empty.
 * Targeted at "global pending badge" UIs that toggle off when there's
 * nothing left to send. Does NOT fire on the initial empty state at
 * client construction.
 */
export interface OutboxDrainedEvent {
  type: 'outbox_drained';
}

/**
 * Phase 5D: self-side read-cursor advance. Fires when the local
 * `channel.read_pts` actually advances — the SDK has already MAX-
 * merged the cache + zeroed `unread_count` BEFORE this event emits.
 * No-op pushes (incoming `read_pts <= channel.read_pts`) are
 * suppressed to avoid spurious UI re-renders. See
 * `docs/PHASE5D_READ_CURSOR_EVENTS_PLAN.md` Decisions §3.
 */
export interface ReadCursorUpdatedEvent {
  type: 'read_cursor_updated';
  channel_id: string;
  channel_type: number;
  /** Always the current user; kept on the event so generic handlers
   *  shared with the peer variant don't have to special-case. */
  reader_id: string;
  /** Decimal string at the SDK boundary (per-channel pts). */
  read_pts: string;
  /** Pre-merge `channel.read_pts`. Omitted on cold-start paths
   *  where no prior value existed. */
  previous_read_pts?: string;
  /** Server wall-clock millis when the broadcast was emitted.
   *  Optional — push-driven paths populate it; direct `markRead`
   *  echoes may not. */
  updated_at?: number;
}

/**
 * Phase 5D: peer-side read-cursor advance for a 1:1 channel. The
 * other member has read up to `read_pts`. The SDK does NOT project
 * this anywhere — no cache write, no IDB row, no in-memory map.
 * Host apps render their own "read by" markers off this event.
 *
 * Group channels do NOT generate peer events (the server's group
 * read-state surface is query-based, not push-based); the SDK
 * defensively suppresses any peer push with `channel_type !== 1`
 * and logs a warning.
 */
export interface PeerReadCursorUpdatedEvent {
  type: 'peer_read_cursor_updated';
  channel_id: string;
  /** Always 1 in v1; the SDK suppresses anything else. */
  channel_type: number;
  /** The peer who advanced — NOT the current user. */
  reader_id: string;
  read_pts: string;
  /** Reserved for shape symmetry with the self variant. v1 always
   *  omits it (the SDK doesn't track peer state to diff against). */
  previous_read_pts?: string;
  updated_at?: number;
}

/**
 * Slot reserved for sources not yet wired in this SDK phase
 * (status changes, entity changes, presence, typing, recovery
 * lifecycle). Listed here so consumers can write exhaustive switches
 * that stay valid as future phases populate them.
 *
 * Note: the original `outbound_queue_drained` slot is now realised as
 * `outbox_drained` (Phase 5C) — kept out of the reserved list since
 * it's emitted today.
 */
export type ReservedL1Type =
  | 'message_status_changed'
  | 'entity_changed'
  | 'presence_changed'
  | 'recovery_lifecycle_changed';

/**
 * Inbound peer-typing notification. Emitted when the SDK receives a
 * `PublishRequest` packet with `topic="typing"` for a channel the
 * client is subscribed to. The server already filters out the typing
 * sender's own session, so this event always represents *another*
 * party in the channel.
 *
 * `is_typing=false` is the explicit "stopped" signal — UI must clear
 * the indicator on receipt rather than waiting for a timeout. UI
 * should ALSO clear after a few seconds with no follow-up `true` to
 * defend against missed `false` (mobile background, network drop).
 *
 * `action_type` is a free-form server-side hint (e.g. "text", "voice");
 * R3.1 only renders the generic "正在输入…" string regardless.
 */
export interface TypingReceivedEvent {
  type: 'typing_received';
  channel_id: string;
  channel_type: number;
  /** Sender uid as decimal string (server emits u64 number; SDK
   *  stringifies for the public boundary). */
  user_id: string;
  is_typing: boolean;
  action_type?: string;
  /** Server unix-seconds timestamp at the time of dispatch. */
  timestamp: number;
}

/**
 * Generic inbound channel publish for **non-typing** topics. Emitted when
 * the SDK receives a `PublishRequest` packet for a channel the client is
 * subscribed to, whose `topic` is anything other than `"typing"` (typing
 * keeps its dedicated `typing_received` event).
 *
 * This is the transport for application-defined room broadcasts —
 * notably the game module's table-state fan-out (`topic="game_state"` /
 * `"hand_started"` / `"state_updated"` etc.). The SDK does NOT interpret
 * the payload; it forwards `topic` + raw `payload_text` (the publish
 * bytes decoded as UTF-8, which the game server sends as JSON) so the
 * application layer can parse per-topic.
 *
 * Consumers should match on `channel_id` + `topic` and parse
 * `payload_text` as needed. Unknown topics can be safely ignored.
 */
export interface ChannelPublishReceivedEvent {
  type: 'channel_publish_received';
  channel_id: string;
  /** Publisher-chosen discriminator, e.g. "game_state". Never "typing"
   *  (that path emits `typing_received` instead). */
  topic: string;
  /** Publish payload decoded as UTF-8 text. Game server sends JSON here;
   *  caller does `JSON.parse(payload_text)`. Empty string when the
   *  publish carried no payload. */
  payload_text: string;
  /** Publishing user id (decimal string); empty for system publishes. */
  publisher: string;
  /** Server unix-seconds timestamp at publish time. */
  timestamp: number;
}

export type SdkEvent =
  | ConnectionStateChangedEvent
  | MessageReceivedEvent
  | MessageBatchReceivedEvent
  | PongReceivedEvent
  | AuthExpiredEvent
  | AuthRefreshStartedEvent
  | AuthRefreshSucceededEvent
  | AuthRefreshFailedEvent
  | SessionExpiredEvent
  | SyncFullRebuildRequiredEvent
  | OutboxStateChangedEvent
  | OutboxDrainedEvent
  | ReadCursorUpdatedEvent
  | PeerReadCursorUpdatedEvent
  | TypingReceivedEvent
  | ChannelPublishReceivedEvent;

export interface SequencedSdkEvent {
  sequence_id: number;
  timestamp_ms: number;
  event: SdkEvent;
}

// ----- Bus implementation -----

export interface EventBusOptions {
  /** Ring buffer capacity for `recentEvents` / `eventsSince` (default 1024). */
  historyLimit?: number;
}

export class EventBus {
  private readonly listeners: Array<(env: SequencedSdkEvent) => void> = [];
  private readonly history: SequencedSdkEvent[] = [];
  private readonly historyLimit: number;
  private nextSequenceId = 0;

  constructor(opts: EventBusOptions = {}) {
    this.historyLimit = Math.max(1, opts.historyLimit ?? 1024);
  }

  /** Last allocated sequence_id (0 before any event has been emitted). */
  lastSequenceId(): number {
    return this.nextSequenceId;
  }

  /** Most recent N events, oldest first. Drops entries beyond the buffer. */
  recentEvents(limit: number): SequencedSdkEvent[] {
    if (limit <= 0) return [];
    const start = Math.max(0, this.history.length - limit);
    return this.history.slice(start);
  }

  /**
   * All events with `sequence_id > fromSequenceId`, capped to `limit`.
   * Returns empty when caller is fully caught up. Consumer should call
   * with the latest `sequence_id` they have processed.
   */
  eventsSince(fromSequenceId: number, limit: number): SequencedSdkEvent[] {
    if (limit <= 0) return [];
    const out: SequencedSdkEvent[] = [];
    for (const env of this.history) {
      if (env.sequence_id > fromSequenceId) {
        out.push(env);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Subscribe. Returns an unsubscribe function. */
  subscribe(cb: (env: SequencedSdkEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Allocate a sequence id, persist to history, fan out to listeners. */
  emit(event: SdkEvent): SequencedSdkEvent {
    const env: SequencedSdkEvent = {
      sequence_id: ++this.nextSequenceId,
      timestamp_ms: Date.now(),
      event,
    };
    this.history.push(env);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(env);
      } catch {
        /* listener errors must not break the inbound loop */
      }
    }
    return env;
  }
}
