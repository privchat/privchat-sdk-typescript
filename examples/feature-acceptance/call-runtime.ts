// Run: PRIVCHAT_FEATURE_ROOT=/tmp/privchat-features-im.F5xe3a node_modules/.bin/tsx examples/feature-acceptance/call-runtime.ts
// Real secondary-fixture RPC only: no Publish, subscriptions, SQL or media claim.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PrivchatClient, RpcError, parseRpcJson } from '../../src/index.js';
import { RawU64 } from '../../src/codec/safe-json.js';

type Json = Record<string, any>;
type Role = 'owner' | 'admin';
const root = process.env.PRIVCHAT_FEATURE_ROOT;
assert.equal(root, '/tmp/privchat-features-im.F5xe3a', 'only the authorized secondary fixture');
assert.equal(statSync(root).mode & 0o077, 0);
const fixture = parseRpcJson<Json>(readFileSync(`${root}/public.json`, 'utf8'));
const accounts = parseRpcJson<Json>(readFileSync(`${root}/accounts.json`, 'utf8'));
const group = parseRpcJson<Json>(readFileSync(`${root}/group.json`, 'utf8'));
assert.equal(fixture.host, '127.0.0.1');
assert.equal(fixture.wsPort, 58430);
assert.equal(String(group.directChannelId), '4');
const binarySha256 = createHash('sha256').update(readFileSync(`${root}/server-bin`)).digest('hex');
assert.equal(binarySha256, '59c00ae1d531f5bcea8f69920bc19aa955ce602f4c84f70aa6da6912586bd67e');
const evidence = mkdtempSync(`${root}/call-runtime-`);
const checks: string[] = [], violations: string[] = [];
const clients: Endpoint[] = [];
const ownedCalls: string[] = [];
const summaries: Record<string, string> = {};
let phase = 'login';
let success = false;
let failure: Json | undefined;
const id = (value: unknown): string => {
  assert.ok(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)), 'lossless ID required');
  const text = String(value);
  assert.match(text, /^\d+$/);
  return text;
};
const raw = (value: unknown) => new RawU64(id(value));
const rpc = (e: Endpoint, route: string, body: Json = {}) => e.client.rpcCallTyped<Json, Json>(route, body);
const mutation = (callId: string) => ({ command_id: randomUUID(), call_id: raw(callId), supports_peer: true });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually<T>(label: string, probe: () => Promise<T | undefined>, timeout = 20000): Promise<T> {
  const until = Date.now() + timeout;
  do {
    assert.equal(violations.length, 0, violations.join('; '));
    const found = await probe();
    if (found !== undefined) return found;
    await sleep(150);
  } while (Date.now() < until);
  throw new Error(`Timed out: ${label}`);
}
async function denied(e: Endpoint, route: string, body: Json, text?: RegExp) {
  await assert.rejects(rpc(e, route, body), (error: unknown) => {
    assert.ok(error instanceof RpcError, 'server rejection, not transport failure');
    assert.notEqual(error.response.code, 0);
    if (text) assert.match(error.response.message, text);
    else assert.equal(error.response.code, 10004, 'PermissionDenied required');
    return true;
  });
}
interface Endpoint {
  client: PrivchatClient;
  uid: string;
  device: string;
  token: string;
  states: Json[];
  pushes: Json[];
  label: string;
}
async function login(role: Role, platform: 'ios' | 'macos' | 'web'): Promise<Endpoint> {
  const device = randomUUID(), app = `call-runtime-${platform}`;
  const client = new PrivchatClient({ url: `ws://127.0.0.1:${fixture.wsPort}/gate`, defaultTimeoutMs: 10000,
    defaultDeviceInfo: { device_type: platform, app_id: app, device_name: 'Secondary call acceptance' } });
  const e: Endpoint = { client, uid: '', device, token: '', states: [], pushes: [], label: `${role}-${platform}` };
  clients.push(e);
  client.observeEvents(({ event }) => {
    try {
      if (event.type === 'channel_publish_received' && event.topic.startsWith('call/')) violations.push('call state delivered via Publish');
      if (event.type === 'rpc_notification_received' && event.route === 'call/state') {
        e.states.push(parseRpcJson<Json>(new TextDecoder().decode(event.body)));
      }
      if (event.type === 'message_received') {
        const envelope = parseRpcJson<Json>(new TextDecoder().decode(event.message.payload));
        const content = typeof envelope.content === 'string' ? parseRpcJson<Json>(envelope.content) : undefined;
        if (content?.event === 'call.ended') e.pushes.push({ callId: id(content.call_id),
          messageId: id(event.message.server_message_id), pts: id(event.message.message_seq), messageType: event.message.message_type });
      }
    } catch {
      // Other message payload formats are unrelated to this call fixture.
    }
  });
  await client.connect();
  const auth = await rpc(e, 'account/auth/login', { username: accounts[role].username, password: accounts[role].password,
    device_id: device, device_info: { device_id: device, device_type: platform, app_id: app, device_name: 'Secondary call acceptance' } });
  e.uid = id(auth.user_id); e.token = auth.token;
  assert.equal(e.uid, id(accounts[role].user_id));
  assert.equal(auth.device_id, device);
  await client.authenticate(e.uid, e.token, device);
  return e;
}
async function state(e: Endpoint, callId: string, expected: string) {
  return eventually(`${e.label} one-way ${expected}`, async () => e.states.find(s => id(s.call.call_id) === callId && s.call.state === expected));
}
async function history(e: Endpoint, callId: string) {
  const response = await e.client.messageHistory(id(group.directChannelId), 100);
  return response.messages.filter(message => {
    try { const content = parseRpcJson<Json>(message.content); return content.event === 'call.ended' && id(content.call_id) === callId; }
    catch { return false; }
  });
}
async function exactlyOnce(e: Endpoint, callId: string) {
  const rows = await eventually('canonical system history', async () => {
    const rows = await history(e, callId);
    assert.ok(rows.length <= 1, 'duplicate call summary in uncached server history');
    return rows.length === 1 ? rows : undefined;
  });
  assert.equal(rows[0]!.message_type, 'system');
  const messageId = id(rows[0]!.message_id);
  assert.ok(BigInt(messageId) > 0n);
  const push = await eventually('actual summary push', async () => e.pushes.find(p => p.callId === callId));
  assert.equal(push.messageId, messageId);
  assert.equal(push.pts, id(rows[0]!.message_seq));
  summaries[callId] = messageId;
}
try {
  const owner = await login('owner', 'web');
  const phone = await login('admin', 'ios');
  const desktop = await login('admin', 'macos');
  const direct = await owner.client.channelDirectGetOrCreate(raw(phone.uid) as any, 'friend');
  assert.equal(id(direct.channel_id), id(group.directChannelId), 'seed DM is owner/alice to admin/bob');
  for (const e of [owner, phone]) assert.deepEqual((await rpc(e, 'call/active')).calls, [], 'do not alter someone else\'s active call');
  const caps = await rpc(owner, 'call/capabilities');
  assert.equal(caps.enabled, true); assert.equal(caps.peer_enabled, true);
  assert.equal(caps.heartbeat_lease_seconds, 60);
  checks.push('secondary frozen server; owner/admin DM; three real login/auth devices; capabilities');
  const invite = () => ({ command_id: randomUUID(), channel_id: raw(group.directChannelId), media_kind: 'audio', supports_peer: true });
  phase = 'ringing cancellation and busy arbitration';
  const request = invite(), offered = await rpc(owner, 'call/invite', request);
  const cancelledId = id(offered.call.call_id); ownedCalls.push(cancelledId);
  assert.equal(typeof offered.call.call_id, 'string');
  assert.ok(BigInt(cancelledId) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(await rpc(owner, 'call/invite', request), offered, 'idempotent invite');
  assert.deepEqual(new Set(offered.call.participants.map((p: Json) => id(p.user_id))), new Set([owner.uid, phone.uid]));
  await Promise.all([state(phone, cancelledId, 'ringing'), state(desktop, cancelledId, 'ringing')]);
  for (const e of [owner, phone]) {
    assert.ok((await rpc(e, 'call/active')).calls.some((c: Json) => id(c.call_id) === cancelledId));
    await denied(e, 'call/invite', invite(), /busy/i);
  }
  const cancel = mutation(cancelledId), cancelled = await rpc(owner, 'call/cancel', cancel);
  assert.equal(cancelled.call.state, 'ended'); assert.equal(cancelled.call.end_reason, 'cancelled');
  assert.deepEqual(await rpc(owner, 'call/cancel', cancel), cancelled);
  await Promise.all(clients.map(e => state(e, cancelledId, 'ended')));
  await exactlyOnce(phone, cancelledId);
  checks.push('lossless snowflake; idempotent invite/cancel; both users busy; two devices receive one-way ringing/ended; one system summary');
  phase = 'first accept and device authorization';
  const activeOffer = await rpc(owner, 'call/invite', invite());
  const activeId = id(activeOffer.call.call_id); ownedCalls.push(activeId);
  await Promise.all([state(phone, activeId, 'ringing'), state(desktop, activeId, 'ringing')]);
  const join = mutation(activeId);
  const race = await Promise.allSettled([rpc(phone, 'call/join', join), rpc(desktop, 'call/join', join)]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1, 'exactly one device wins concurrent join');
  const winner = race[0]!.status === 'fulfilled' ? phone : desktop;
  const loser = winner === phone ? desktop : phone;
  const rejected = race.find(r => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof RpcError);
  assert.equal(rejected.reason.response.code, 10004);
  const joined = race.find(r => r.status === 'fulfilled');
  assert.ok(joined?.status === 'fulfilled');
  assert.equal(joined.value.call.transport, 'webrtc'); assert.equal(joined.value.token, '');
  assert.equal(joined.value.peer.offerer, false);
  const callerJoin = await rpc(owner, 'call/join', mutation(activeId));
  assert.equal(callerJoin.peer.offerer, true);
  await Promise.all(clients.map(e => state(e, activeId, 'active')));
  const offer = { ...mutation(activeId), revision: 1, kind: 'offer', payload: 'v=0\r\ns=secondary-private-test\r\n' };
  await denied(loser, 'call/peer/signal', offer);
  await denied(loser, 'call/end', mutation(activeId)); // Existing wire hangup route is call/end.
  await denied(loser, 'call/heartbeat', mutation(activeId));
  const sent = await rpc(owner, 'call/peer/signal', offer);
  assert.deepEqual(await rpc(owner, 'call/peer/signal', offer), sent);
  const journal = await rpc(winner, 'call/peer/events', { call_id: raw(activeId), after_seq: 0 });
  assert.equal(journal.events.length, 1); assert.equal(journal.events[0].payload, offer.payload);
  assert.equal(id(journal.events[0].from_user_id), owner.uid);
  await denied(loser, 'call/peer/events', { call_id: raw(activeId), after_seq: 0 });
  checks.push('concurrent first-accept exactly one; loser cannot signal/end/heartbeat/read peer journal; authorized signal/replay');
  phase = 'reconnect and terminal history';
  await owner.client.disconnect(); await owner.client.connect();
  await owner.client.authenticate(owner.uid, owner.token, owner.device);
  const recovered = await rpc(owner, 'call/get', { call_id: raw(activeId) });
  assert.equal(id(recovered.call.call_id), activeId); assert.equal(recovered.call.state, 'active');
  const end = mutation(activeId), ended = await rpc(winner, 'call/end', end);
  assert.equal(ended.call.state, 'ended'); assert.equal(ended.call.end_reason, 'normal');
  assert.deepEqual(await rpc(winner, 'call/end', end), ended);
  await Promise.all(clients.map(e => state(e, activeId, 'ended')));
  await exactlyOnce(phone, activeId);
  await denied(owner, 'call/peer/signal', offer);
  await owner.client.disconnect(); await owner.client.connect();
  await owner.client.authenticate(owner.uid, owner.token, owner.device);
  assert.equal((await rpc(owner, 'call/get', { call_id: raw(activeId) })).call.state, 'ended');
  for (const e of [owner, phone, desktop]) assert.deepEqual((await rpc(e, 'call/active')).calls, []);
  await sleep(2500);
  for (const callId of ownedCalls) {
    const rows = await history(owner, callId);
    assert.equal(rows.length, 1); assert.equal(id(rows[0]!.message_id), summaries[callId]);
  }
  assert.equal(violations.length, 0);
  checks.push('same-device disconnect/auth reconnect recovers active and terminal call/get; idempotent end; both summaries remain exactly once');
  success = true;
} catch (error) {
  failure = { phase, kind: error instanceof Error ? error.name : 'Unknown',
    message: error instanceof Error ? error.message : 'Unknown failure' };
  if (error instanceof RpcError) failure.code = error.response.code;
} finally {
  const owner = clients[0];
  if (owner) for (const callId of ownedCalls) {
    try {
      const current = await rpc(owner, 'call/get', { call_id: raw(callId) });
      if (current.call.state !== 'ended') await rpc(owner, current.call.state === 'ringing' ? 'call/cancel' : 'call/end', mutation(callId));
    } catch { violations.push(`cleanup could not reconcile owned call ${callId}`); }
  }
  await Promise.all(clients.map(e => e.client.disconnect().catch(() => undefined)));
  const report = { success: success && violations.length === 0, passed: success && violations.length === 0 ? 1 : 0,
    failed: success && violations.length === 0 ? 0 : 1, ignored: 0, fixture: root, wsPort: fixture.wsPort,
    binarySha256, checks, callIds: ownedCalls, summaries, violations, failure,
    scope: 'real login/auth, one-way RPC, device contention, peer journal and server system history only; no media/SQL/server restart/crash-injection claim' };
  writeFileSync(`${evidence}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`${report.success ? 'CALL_RUNTIME_PASS' : 'CALL_RUNTIME_FAIL'}: ${report.passed} passed, ${report.failed} failed, 0 ignored; report=${evidence}/report.json`);
  if (!report.success) { console.error(JSON.stringify(failure ?? { violations })); process.exitCode = 1; }
}
