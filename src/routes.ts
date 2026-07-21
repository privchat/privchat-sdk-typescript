// Mirrors `privchat_protocol::rpc::routes` (Rust). Path strings are the
// canonical wire identifier; constant names match the Rust module layout
// so call sites read the same (`Routes.friend.APPLY` ↔ `routes::friend::APPLY`).
//
// Subset only — adds happen as new methods land in the SDK.

export const Routes = {
  account_user: {
    REGISTER: 'account/user/register',
    DETAIL: 'account/user/detail',
  },
  account_search: {
    QUERY: 'account/search/query',
  },
  account_privacy: {
    GET: 'account/privacy/get',
    UPDATE: 'account/privacy/update',
  },
  account_bot: {
    FOLLOW: 'account/bot/follow',
    UNFOLLOW: 'account/bot/unfollow',
  },
  account_auth: {
    REFRESH: 'account/auth/refresh',
  },
  friend: {
    APPLY: 'contact/friend/apply',
    ACCEPT: 'contact/friend/accept',
    REMOVE: 'contact/friend/remove',
    PENDING: 'contact/friend/pending',
    CHECK: 'contact/friend/check',
    SET_ALIAS: 'contact/friend/set_alias',
  },
  blacklist: {
    ADD: 'contact/blacklist/add',
    REMOVE: 'contact/blacklist/remove',
    LIST: 'contact/blacklist/list',
    CHECK: 'contact/blacklist/check',
  },
  channel: {
    DIRECT_GET_OR_CREATE: 'channel/direct/get_or_create',
    PIN: 'channel/pin',
    HIDE: 'channel/hide',
    MUTE: 'channel/mute',
  },
  group: {
    CREATE: 'group/group/create',
    INFO: 'group/group/info',
  },
  group_member: {
    ADD: 'group/member/add',
    LIST: 'group/member/list',
    LEAVE: 'group/member/leave',
    REMOVE: 'group/member/remove',
    MUTE: 'group/member/mute',
    UNMUTE: 'group/member/unmute',
  },
  group_role: {
    SET: 'group/role/set',
    TRANSFER_OWNER: 'group/role/transfer_owner',
  },
  group_settings: {
    GET: 'group/settings/get',
    UPDATE: 'group/settings/update',
    MUTE_ALL: 'group/settings/mute_all',
  },
  group_approval: {
    LIST: 'group/approval/list',
    HANDLE: 'group/approval/handle',
  },
  message: {
    REVOKE: 'message/revoke',
    PIN: 'message/pin',
    PIN_LIST: 'message/pin/list',
  },
  message_status: {
    READ_PTS: 'message/status/read_pts',
  },
  message_history: {
    GET: 'message/history/get',
    /** 云端历史搜索（用户可见范围，MESSAGE_HISTORY spec §4） */
    SEARCH: 'message/history/search',
    /** jump-to-message 上下文（spec §5） */
    AROUND: 'message/history/around',
  },
  message_reaction: {
    ADD: 'message/reaction/add',
    REMOVE: 'message/reaction/remove',
    LIST: 'message/reaction/list',
  },
  presence: {
    TYPING: 'presence/typing',
    STATUS_GET: 'presence/status/get',
  },
  file: {
    REQUEST_UPLOAD_TOKEN: 'file/request_upload_token',
    UPLOAD_CALLBACK: 'file/upload_callback',
    GET_URL: 'file/get_url',
  },
  // QR_CODE_SPEC v1.3 — 个人名片二维码
  user_qrcode: {
    GET: 'user/qrcode/get',
    REFRESH: 'user/qrcode/refresh',
    RESOLVE: 'user/qrcode/resolve',
  },
  // QR_CODE_SPEC v1.3 — 群二维码
  group_qrcode: {
    GET: 'group/qrcode/get',
    REFRESH: 'group/qrcode/refresh',
    JOIN: 'group/join/qrcode',
  },
} as const;
