// Cache module public surface.
export {
  CacheDB,
  clearAll,
  clearChannelMessages,
  deleteFriendships,
  ProjectionRehydrateRequiredError,
  deleteMessageById,
  applyAck,
  deleteMessageByServerId,
  getChannel,
  getCacheOwner,
  getMessageWindow,
  getMessagesBefore,
  getSyncState,
  listChannels,
  listFriendships,
  listGroups,
  listUsers,
  ensureCacheOwner,
  maxFriendshipSyncVersion,
  maxGroupSyncVersion,
  maxUserSyncVersion,
  upsertChannels,
  upsertFriendships,
  upsertGroups,
  upsertMessage,
  upsertMessages,
  upsertSyncState,
  upsertUsers,
} from './indexeddb-store.js';
export {
  claimOutboxEntry,
  claimRepairRow,
  commitRepairTransition,
  commitOutboxTransition,
  deleteOutboxEntryIfOwner,
  deleteOutboxEntryIfRepairOwner,
  deleteOutboxEntry,
  getOutboxByLocalMessageId,
  getOutboxEntry,
  listDueOutboxEntries,
  listOutboxByChannel,
  listOutboxEntries,
  putOutboxEntry,
  updateOutboxStatus,
} from './outbox-store.js';
export type { ListOutboxOptions } from './outbox-store.js';
export { mergeOnPushAbsorb } from './merge.js';
export type { MergePushContext } from './merge.js';
export { MessageStore } from './message-store.js';
export { FriendshipStore, GroupStore, UserStore } from './profile-store.js';
export type {
  ChannelRecord,
  ConversationPatch,
  ConversationSnapshot,
  FriendshipRecord,
  GroupRecord,
  IdString,
  MessageRecord,
  MessageStatus,
  OutboxEntry,
  OutboxStatus,
  SyncStateRecord,
  UserRecord,
} from './types.js';
export {
  compareDisplayOrder,
  displaySortKey,
  encodeSortKey,
  nextLocalMessageRecordId,
  pushToMessageRecord,
} from './types.js';
