// Multi-account orchestrator. Mirrors Rust `examples/accounts/src/account_manager.rs`
// — three accounts (alice/bob/charlie) each with their own PrivchatClient
// connection, registered + authenticated against a real privchat-server.
//
// Routes the SDK already sugars (friend / blacklist / channel / group / etc.)
// are called via the typed methods on `client.X(...)`. Routes the SDK does
// NOT sugar today (`account/user/register`, `sync/get_channel_pts`,
// `sync/submit`) stay as raw `rpcCallTyped` calls here.

import { PrivchatClient, Routes } from '../../../src/index.js';
import type {
  AuthResponse,
  ClientSubmitRequest,
  ClientSubmitResponse,
  GetChannelPtsRequest,
  GetChannelPtsResponse,
  UserRegisterRequest,
} from './rpc-types.js';
import type { AccountConfig } from './types.js';

export const DIRECT_SYNC_CHANNEL_TYPE = 1;
export const GROUP_SYNC_CHANNEL_TYPE = 2;

interface ManagedAccount {
  cfg: AccountConfig;
  client: PrivchatClient;
}

const ENV = (key: string, fallback: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).process?.env?.[key] as string | undefined) ?? fallback;

const ENV_PORT = (key: string, fallback: number): number => {
  const raw = ENV(key, '');
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

let LOCAL_MSG_SEQ = 1;
function nextLocalMessageId(): number {
  // Snowflake-ish: 52-bit safe int (ms timestamp << 12 | 12-bit counter).
  const seq = LOCAL_MSG_SEQ++ & 0x0fff;
  return Date.now() * 0x1000 + seq;
}

const REGISTER_ROUTE = 'account/user/register';
const SYNC_GET_CHANNEL_PTS_ROUTE = 'sync/get_channel_pts';
const SYNC_SUBMIT_ROUTE = 'sync/submit';

export interface MultiAccountManagerInit {
  host?: string;
  wsPort?: number;
  /** Suffix for usernames (so re-runs don't collide). */
  suffix?: string;
}

export class MultiAccountManager {
  readonly accounts = new Map<string, ManagedAccount>();
  readonly directChannels = new Map<string, number>();
  readonly groupChannels = new Map<string, number>();
  readonly suffix: string;
  private readonly url: string;

  private constructor(url: string, suffix: string) {
    this.url = url;
    this.suffix = suffix;
  }

  static async create(opts: MultiAccountManagerInit = {}): Promise<MultiAccountManager> {
    const host = opts.host ?? ENV('PRIVCHAT_HOST', '127.0.0.1');
    const wsPort = opts.wsPort ?? ENV_PORT('PRIVCHAT_WS_PORT', 9080);
    const url = `ws://${host}:${wsPort}/`;
    const suffix =
      opts.suffix ?? `${Date.now() % 100_000}${Math.floor(Math.random() * 1000)}`;

    const m = new MultiAccountManager(url, suffix);
    await m.createAndAuthAccount('alice');
    await m.createAndAuthAccount('bob');
    await m.createAndAuthAccount('charlie');
    return m;
  }

  private async createAndAuthAccount(key: string): Promise<void> {
    const username = `${key}_${this.suffix}`;
    const password = 'password123';
    const device_id = pseudoUuidV4Like();

    const client = new PrivchatClient({ url: this.url, defaultTimeoutMs: 30_000 });
    await client.connect();

    const reg = await client.rpcCallTyped<UserRegisterRequest, AuthResponse>(
      REGISTER_ROUTE,
      {
        username,
        password,
        device_id,
        device_info: {
          device_id,
          device_type: 'web',
          app_id: 'privchat-sdk-ts-example',
          device_name: 'accounts-example',
          app_version: '0.1.0',
        },
      },
    );

    await client.authenticate(String(reg.user_id), reg.token, reg.device_id);

    this.accounts.set(key, {
      cfg: {
        key,
        username,
        password,
        user_id: String(reg.user_id),
        token: reg.token,
        device_id: reg.device_id,
      },
      client,
    });
  }

  // ----- Account lookup -----

  account(key: string): ManagedAccount {
    const a = this.accounts.get(key);
    if (!a) throw new Error(`account not found: ${key}`);
    return a;
  }

  config(key: string): AccountConfig {
    return this.account(key).cfg;
  }

  client(key: string): PrivchatClient {
    return this.account(key).client;
  }

  userId(key: string): string {
    return this.account(key).cfg.user_id;
  }

  username(key: string): string {
    return this.account(key).cfg.username;
  }

  accountKeys(): string[] {
    return Array.from(this.accounts.keys());
  }

  async verifyAllConnected(): Promise<void> {
    for (const [key, a] of this.accounts) {
      if (!a.client.isConnected()) throw new Error(`account ${key} not connected`);
    }
  }

  async cleanup(): Promise<void> {
    for (const a of this.accounts.values()) {
      try {
        await a.client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  // ----- Friend / direct-channel cache helper -----

  /**
   * Wraps `client.channelDirectGetOrCreate` and remembers the channel id
   * so later phases can look it up by `(a, b)` pair.
   */
  async getOrCreateDirectChannel(from: string, to: string): Promise<number> {
    const toUid = Number(this.userId(to));
    const resp = await this.client(from).channelDirectGetOrCreate(
      toUid,
      'accounts-example',
      'phase3',
    );
    this.directChannels.set(directKey(from, to), resp.channel_id);
    return resp.channel_id;
  }

  cachedDirectChannel(a: string, b: string): number | undefined {
    return this.directChannels.get(directKey(a, b));
  }

  // ----- send_text via sync/submit (route NOT sugared by the SDK) -----

  /**
   * Mirrors Rust accounts.account_manager::send_text: fetch channel PTS,
   * then submit via `sync/submit`. Server decides accept/transform/reject.
   * The SDK doesn't expose typed wrappers for these sync routes — they
   * belong to the higher-level "client message flow", not the wire facade.
   */
  async sendText(
    key: string,
    channelId: number,
    channelType: number,
    text: string,
  ): Promise<ClientSubmitResponse> {
    const client = this.client(key);
    const pts = await client.rpcCallTyped<GetChannelPtsRequest, GetChannelPtsResponse>(
      SYNC_GET_CHANNEL_PTS_ROUTE,
      { channel_id: channelId, channel_type: channelType },
    );

    return client.rpcCallTyped<ClientSubmitRequest, ClientSubmitResponse>(
      SYNC_SUBMIT_ROUTE,
      {
        local_message_id: nextLocalMessageId(),
        channel_id: channelId,
        channel_type: channelType,
        last_pts: pts.current_pts,
        command_type: 'text',
        payload: { content: text, metadata: null },
        client_timestamp: Date.now(),
      },
    );
  }
}

function directKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function pseudoUuidV4Like(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Routes constant re-export so phase code can reach unsugared routes too.
export { Routes };
