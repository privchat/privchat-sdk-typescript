// PrivChat TypeScript SDK — Channel Transfer example.
//
// Demonstrates the client→app RPC over `biz_type=19` (TransferRequest) /
// `biz_type=20` (TransferResponse). The same wire envelope carries
// bot/menu, game/poker, wallet/balance, etc. The SDK does NOT interpret
// `body` / `data` bytes — encoding is decided by `route`.
//
// Spec:
//   - 02-server/CHANNEL_TRANSFER_SPEC.md v2.0
//   - 07-application/CHANNEL_TRANSFER_DISPATCH_SPEC.md v1.0
//   - 07-application/BOT_INTERACTION_SPEC.md
//
// Env vars:
//   PRIVCHAT_HOST                 server hostname (default 127.0.0.1)
//   PRIVCHAT_WS_PORT              WebSocket port  (default 9080)
//   PRIVCHAT_TRANSFER_ROUTE       route to call   (default bot/menu/get)
//   PRIVCHAT_TRANSFER_BODY        UTF-8 body bytes (default empty)
//   PRIVCHAT_TRANSFER_CHANNEL_ID  target channel id (default: ask user to set)
//
// Pre-conditions (any of these will work):
//   1. privchat-application has a registered service handler for the route's
//      service prefix (e.g. bot/menu/get → BotMenuTransferHandler).
//   2. privchat_business_channel has a binding row for the target channel
//      pointing to that service, with dispatch_transfer_enabled=1.
//
// Without those the response will still be a valid 209xx error — proving
// wire/relay/dispatch are wired, just no service for that channel yet.

import { PrivchatClient, Routes } from '../../../src/index.js';

interface UserRegisterRequest {
  username: string;
  password: string;
  device_id: string;
  device_info: {
    device_id: string;
    device_type: string;
    app_id: string;
    device_name: string;
    app_version: string;
  };
}

interface AuthResponse {
  user_id: number;
  token: string;
  device_id: string;
}

async function main(): Promise<void> {
  console.log('\nPrivChat SDK Channel Transfer Example — TypeScript');
  console.log('==================================================');

  const host = process.env.PRIVCHAT_HOST ?? '127.0.0.1';
  const wsPort = Number.parseInt(process.env.PRIVCHAT_WS_PORT ?? '9080', 10);
  const url = `ws://${host}:${wsPort}/`;
  const route = process.env.PRIVCHAT_TRANSFER_ROUTE ?? 'bot/menu/get';
  const body = new TextEncoder().encode(process.env.PRIVCHAT_TRANSFER_BODY ?? '');
  const explicitChannelId = process.env.PRIVCHAT_TRANSFER_CHANNEL_ID;

  // ── 1) connect ─────────────────────────────────────────────────────
  console.log('1) connect →', url);
  const client = new PrivchatClient({ url, defaultTimeoutMs: 30_000 });
  await client.connect();

  // ── 2) register / login fallback ───────────────────────────────────
  const suffix = `${Date.now() % 100_000}${Math.floor(Math.random() * 1000)}`;
  const username = `transfer_${suffix}`;
  const password = 'password123';
  const deviceId = pseudoUuidV4Like();

  console.log(`2) register/login as ${username}`);
  const reg = await client.rpcCallTyped<UserRegisterRequest, AuthResponse>(
    Routes.account_user.REGISTER,
    {
      username,
      password,
      device_id: deviceId,
      device_info: {
        device_id: deviceId,
        device_type: 'web',
        app_id: 'privchat-sdk-ts-example',
        device_name: 'transfer-example',
        app_version: '0.1.0',
      },
    },
  );
  console.log(`   user_id=${reg.user_id}`);

  console.log('3) authenticate');
  await client.authenticate(String(reg.user_id), reg.token, reg.device_id);

  // ── 3) pick channel ────────────────────────────────────────────────
  let channelId: string;
  if (explicitChannelId) {
    channelId = explicitChannelId;
    console.log(`4) using PRIVCHAT_TRANSFER_CHANNEL_ID=${channelId}`);
  } else {
    console.log(
      '4) PRIVCHAT_TRANSFER_CHANNEL_ID not set — please set it to a direct channel id with a bot/service user',
    );
    await client.disconnect();
    return;
  }

  // ── 4) the actual transfer call ────────────────────────────────────
  const requestId = pseudoUuidV4Like();
  console.log(
    `5) transfer  channel_id=${channelId} route='${route}' body_len=${body.length} request_id=${requestId}`,
  );

  const reply = await client.transfer({
    request_id: requestId,
    channel_id: channelId,
    route,
    body,
  });

  console.log('--- TransferResponse ---');
  console.log(`  request_id  : ${reply.request_id}`);
  console.log(`  channel_id  : ${reply.channel_id}`);
  console.log(`  code        : ${reply.code}`);
  console.log(`  message     : ${reply.message}`);
  console.log(`  data_len    : ${reply.data?.length ?? 0}`);
  if (reply.data && reply.data.length > 0) {
    // Try UTF-8 (most routes use JSON); fall back to hex preview.
    const text = tryDecodeUtf8(reply.data);
    if (text !== null) {
      const preview = text.length > 800 ? `${text.slice(0, 800)}…` : text;
      console.log(`  data (utf8) : ${preview}`);
    } else {
      const hex = Array.from(reply.data.slice(0, 64))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      console.log(
        `  data (hex)  : ${hex}${reply.data.length > 64 ? ' …' : ''}`,
      );
    }
  }

  console.log();
  switch (reply.code) {
    case 0:
      console.log('✓ OK — wire + relay + dispatch + handler all green.');
      break;
    case 20900:
      console.log('× ChannelNotSubscribed — subscribe the channel first.');
      break;
    case 20901:
      console.log(
        `× ChannelNotBound — no privchat_business_channel row for channel ${channelId} (or dispatch_transfer_enabled=0).`,
      );
      break;
    case 20902:
      console.log(
        `× TransferServiceNotFound — route prefix '${route.split('/')[0]}' doesn't match any registered service.`,
      );
      break;
    case 20903:
      console.log('× TransferServiceDisabled — service.status = 0.');
      break;
    case 20904:
      console.log('× TransferCallbackFailed — external callback URL unreachable.');
      break;
    default:
      if (reply.code >= 20000) {
        console.log(
          `× business code ${reply.code} — handler returned this; not a framework error.`,
        );
      } else {
        console.log(`× code ${reply.code} — see ERROR_CODE_SPEC for segment ownership.`);
      }
  }

  console.log('\n6) disconnect');
  await client.disconnect();

  console.log('\nDone');
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function pseudoUuidV4Like(): string {
  const t = Date.now();
  const p = Math.floor(Math.random() * 0xffff_ffff);
  const seg = (n: number, w: number): string =>
    n.toString(16).padStart(w, '0').slice(-w);
  return `${seg(t >>> 0, 8)}-${seg((t / 0x10000) >>> 0, 4)}-${seg(p & 0xffff, 4)}-${seg((p >>> 16) & 0xffff, 4)}-${seg((t ^ p) >>> 0, 8)}${seg(p, 4)}`;
}

main().catch((err) => {
  console.error('transfer example failed:', err);
  process.exitCode = 1;
});
