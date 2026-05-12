// Default ClientInfo / DeviceInfo + local_message_id generator used by the
// Layer-2 convenience wrappers (authenticate / sendTextMessage). These
// mirror the env-derived defaults in the Rust SDK's `authenticate()` —
// kept intentionally simple here; consumers needing precise fields should
// pass an explicit AuthorizationRequest to `authorize()` instead.

import type { ClientInfo, DeviceInfo, DeviceType } from './codec/auth.js';

const APP_VERSION = '0.1.0';
const PROTOCOL_VERSION = '1.0';

function detectOs(): { os: string; deviceType: DeviceType } {
  // Node.js
  const proc = (globalThis as { process?: { platform?: string } }).process;
  const platform = proc?.platform;
  if (platform === 'darwin') return { os: 'macos', deviceType: 'macos' };
  if (platform === 'linux') return { os: 'linux', deviceType: 'linux' };
  if (platform === 'win32') return { os: 'windows', deviceType: 'windows' };

  // Browser
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  const ua = nav?.userAgent ?? '';
  if (/Android/i.test(ua)) return { os: 'android', deviceType: 'android' };
  if (/iPhone|iPad|iPod/i.test(ua)) return { os: 'ios', deviceType: 'ios' };
  if (/Mac OS X/i.test(ua)) return { os: 'macos', deviceType: 'web' };
  if (/Windows/i.test(ua)) return { os: 'windows', deviceType: 'web' };
  if (/Linux/i.test(ua)) return { os: 'linux', deviceType: 'web' };

  return { os: 'unknown', deviceType: 'unknown' };
}

export function defaultClientInfo(): ClientInfo {
  const { os } = detectOs();
  return {
    client_type: os,
    version: APP_VERSION,
    os,
    os_version: os,
  };
}

export function defaultDeviceInfo(device_id: string): DeviceInfo {
  const { os, deviceType } = detectOs();
  return {
    device_id,
    device_type: deviceType,
    app_id: 'privchat-sdk-ts',
    device_name: os,
    os_version: os,
    app_version: APP_VERSION,
  };
}

export function defaultProtocolVersion(): string {
  return PROTOCOL_VERSION;
}

// Snowflake-ish u64 encoded as a decimal string. Combines a millisecond
// timestamp with a per-instance counter so concurrent calls within the
// same millisecond stay distinct. Suitable as a `local_message_id` for
// Phase 2's direct-send path.
let counter = 0;
export function generateLocalMessageId(): string {
  counter = (counter + 1) & 0x3ff; // 10-bit rollover
  const ms = BigInt(Date.now());
  return ((ms << 12n) | BigInt(counter)).toString();
}
