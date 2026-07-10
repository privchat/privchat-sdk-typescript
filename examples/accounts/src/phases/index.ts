import type { PhaseFn } from '../coordinator.js';
import { phase01_auth_and_bootstrap } from './phase01-auth.js';
import { phase02_friend_system } from './phase02-friend.js';
import { phase03_direct_send } from './phase03-direct-send.js';
import { phase04_account_search } from './phase04-account-search.js';
import { phase05_blacklist } from './phase05-blacklist.js';
import { phase06_entity_sync } from './phase06-entity-sync.js';
import { phase07_group_lifecycle } from './phase07-group-lifecycle.js';
import { phase08_message_history } from './phase08-message-history.js';
import { phase09_reactions } from './phase09-reactions.js';
import { phase10_typing_presence } from './phase10-typing-presence.js';
import { phase11_cache_smoke } from './phase11-cache-smoke.js';
import { phase12_mark_read } from './phase12-mark-read.js';
import { phase13_sync_gap_fill } from './phase13-sync-gap-fill.js';
import { phase14_outbox } from './phase14-outbox.js';
import { phase15_read_cursor_events } from './phase15-read-cursor-events.js';
import { phase16_profile_cache } from './phase16-profile-cache.js';
import { phase17_friendship_cache } from './phase17-friendship-cache.js';
import { phase18_history_search_jump } from './phase18-history-search-jump.js';

export const phases: PhaseFn[] = [
  phase01_auth_and_bootstrap,
  phase02_friend_system,
  phase03_direct_send,
  phase04_account_search,
  phase05_blacklist,
  phase06_entity_sync,
  phase07_group_lifecycle,
  phase08_message_history,
  phase09_reactions,
  phase10_typing_presence,
  phase11_cache_smoke,
  phase12_mark_read,
  phase13_sync_gap_fill,
  phase14_outbox,
  phase15_read_cursor_events,
  phase16_profile_cache,
  phase17_friendship_cache,
  phase18_history_search_jump,
];
