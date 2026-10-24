// Test-only replacement for the Kotlin file carrier; never run both in one directory.
// PRIVCHAT_FEATURE_ROOT=/tmp/privchat-features-im.F5xe3a node_modules/.bin/tsx examples/feature-acceptance/native-media-carrier.ts --dry-run|--serve
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { PrivchatClient, RpcError, parseRpcJson } from '../../src/index.js';
import { RawU64 } from '../../src/codec/safe-json.js';

type Json = Record<string, any>;
type Side = 'caller' | 'callee';
const sides: Side[] = ['caller', 'callee'];
const mode = process.argv[2];
assert.ok(mode === '--dry-run' || mode === '--serve', 'explicit --dry-run or --serve required');
const root = process.env.PRIVCHAT_FEATURE_ROOT;
assert.equal(root, '/tmp/privchat-features-im.F5xe3a', 'authorized secondary only');
assert.equal(statSync(root).mode & 0o077, 0);
const fixture = parseRpcJson<Json>(readFileSync(`${root}/public.json`, 'utf8'));
const accounts = parseRpcJson<Json>(readFileSync(`${root}/accounts.json`, 'utf8'));
const group = parseRpcJson<Json>(readFileSync(`${root}/group.json`, 'utf8'));
assert.equal(fixture.host, '127.0.0.1'); assert.equal(fixture.wsPort, 58430);
assert.equal(String(group.directChannelId), '4');
const binarySha256 = createHash('sha256').update(readFileSync(`${root}/server-bin`)).digest('hex');
assert.equal(binarySha256, '59c00ae1d531f5bcea8f69920bc19aa955ce602f4c84f70aa6da6912586bd67e');
const timeout = Number(process.env.PRIVCHAT_NATIVE_TIMEOUT_MS ?? 600000);
assert.ok(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 1200000);
const parent = process.env.PRIVCHAT_NATIVE_EXCHANGE_PARENT ?? '/tmp';
if (parent !== '/tmp') {
  assert.match(parent, /^\/Users\/[^/]+\/Library\/Developer\/CoreSimulator\/Devices\/[A-Fa-f0-9-]+\/data\/Containers\/Data\/Application\/[A-Fa-f0-9-]+\/Documents$/);
  assert.equal(realpathSync(parent), parent, 'canonical simulator Documents directory required');
  assert.equal(statSync(parent).uid, process.getuid!());
}
const exchangeName = process.env.PRIVCHAT_NATIVE_EXCHANGE_NAME;
if (exchangeName !== undefined) {
  assert.notEqual(parent, '/tmp', 'named exchanges require the authorized simulator Documents directory');
  assert.match(exchangeName, /^privchat-native-peer-[A-Za-z0-9-]{8,64}$/);
}
const directory = exchangeName === undefined ? mkdtempSync(`${parent}/privchat-native-peer-ts.`) : `${parent}/${exchangeName}`;
if (exchangeName !== undefined) mkdirSync(directory, { mode: 0o700 });
assert.equal(lstatSync(directory).mode & 0o777, 0o700);
// Keep cancellation/evidence outside a simulator container that Xcode may delete.
const control = mkdtempSync('/tmp/privchat-native-peer-control.');
writeFileSync(`${control}/pid`, String(process.pid), { mode: 0o600, flag: 'wx' });
writeFileSync(`${directory}/broker.lock`, String(process.pid), { mode: 0o600, flag: 'wx' });
const sourceSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const id = (value: unknown): string => {
  assert.ok(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)), 'unsafe ID');
  const result = String(value); assert.match(result, /^\d+$/); return result;
};
const raw = (value: unknown) => new RawU64(id(value));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function write(name: string, value: Json) {
  const target = `${directory}/${name}`, temp = `${target}.${randomUUID()}.tmp`;
  assert.ok(!existsSync(target), 'exchange files must not be overwritten');
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temp, target);
}
function read(name: string): Json | undefined {
  const file = `${directory}/${name}`;
  if (!existsSync(file)) return undefined;
  const entry = lstatSync(file);
  assert.ok(entry.isFile() && !entry.isSymbolicLink(), 'regular exchange file required');
  // Swift atomically writes then chmods: wait for its private mode before opening.
  if ((entry.mode & 0o077) !== 0) return undefined;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 262144);
    assert.equal(stat.mode & 0o077, 0);
    return parseRpcJson<Json>(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
interface Session { client: PrivchatClient; uid: string }
const sessions: Partial<Record<Side, Session>> = {};
const sent = { caller: 0, callee: 0 }, received = { caller: 0, callee: 0 };
const cursors = { caller: '0', callee: '0' };
const heartbeatCounts = { caller: 0, callee: 0 };
const rpc = async (side: Side, route: string, body: Json = {}): Promise<Json> => {
  const session = sessions[side]; assert.ok(session);
  for (let attempt = 0; ; attempt++) {
    try { return await session.client.rpcCallTyped<Json, Json>(route, body); }
    catch (error) {
      if (!(error instanceof RpcError) || !route.startsWith('call/peer/') || attempt >= 10 ||
          error.response.code !== 10100 || error.response.message !== 'Peer signalling rate limit; retry later') throw error;
      await sleep(1000);
    }
  }
};
let phase = 'login', callId: string | undefined, completed = false, stopped = false;
let nativeResult: Json | undefined, failure: Json | undefined, cleanup = 'not-needed';
const started = Date.now();
process.once('SIGTERM', () => { stopped = true; });
process.once('SIGINT', () => { stopped = true; });
async function login(side: Side, role: 'owner' | 'admin', platform: 'web' | 'macos') {
  const client = new PrivchatClient({ url: `ws://127.0.0.1:${fixture.wsPort}/gate`, defaultTimeoutMs: 10000,
    defaultDeviceInfo: { device_type: platform, app_id: `native-peer-ts-${side}`, device_name: 'Private native peer acceptance' } });
  sessions[side] = { client, uid: '' };
  await client.connect();
  const device = randomUUID();
  const auth = await rpc(side, 'account/auth/login', { username: accounts[role].username, password: accounts[role].password,
    device_id: device, device_info: { device_id: device, device_type: platform,
      app_id: `native-peer-ts-${side}`, device_name: 'Private native peer acceptance' } });
  sessions[side]!.uid = id(auth.user_id);
  assert.equal(id(auth.user_id), id(accounts[role].user_id));
  await client.authenticate(id(auth.user_id), auth.token, device);
}
const mutation = () => { assert.ok(callId); return { call_id: raw(callId), command_id: randomUUID(), supports_peer: true }; };
function peer(value: Json, side: Side) {
  assert.ok(value && typeof value.offerer === 'boolean' && Array.isArray(value.ice_servers));
  const other = side === 'caller' ? 'callee' : 'caller';
  assert.equal(id(value.self_user_id), sessions[side]!.uid);
  assert.equal(id(value.peer_user_id), sessions[other]!.uid);
  assert.equal(value.offerer, side === 'caller');
  return { ...value, self_user_id: id(value.self_user_id), peer_user_id: id(value.peer_user_id) };
}
async function heartbeat() {
  for (const side of sides) { await rpc(side, 'call/heartbeat', mutation()); heartbeatCounts[side]++; }
}
async function pump(side: Side) {
  assert.ok(callId);
  for (let batch = 0; batch < 32; batch++) {
    const index = sent[side] + 1;
    const signal = read(`${side}-out-${String(index).padStart(6, '0')}.json`);
    if (!signal) break;
    assert.ok(Number.isSafeInteger(signal.revision) && signal.revision > 0);
    assert.ok(['offer', 'answer', 'ice'].includes(signal.kind));
    assert.equal(typeof signal.payload, 'string');
    assert.ok(Buffer.byteLength(signal.payload) <= 262144);
    await rpc(side, 'call/peer/signal', { call_id: raw(callId), command_id: `native-ts-${callId}-${side}-${index}`,
      revision: signal.revision, kind: signal.kind, payload: signal.payload });
    sent[side] = index;
  }
  const page = await rpc(side, 'call/peer/events', { call_id: raw(callId), after_seq: raw(cursors[side]) });
  assert.ok(Array.isArray(page.events) && page.events.length <= 256);
  for (const event of page.events) {
    const seq = id(event.seq), other = side === 'caller' ? 'callee' : 'caller';
    assert.ok(BigInt(seq) > BigInt(cursors[side]), 'no duplicate inbound journal event');
    assert.equal(id(event.from_user_id), sessions[other]!.uid);
    assert.ok(Number.isSafeInteger(event.revision) && event.revision > 0);
    assert.ok(['offer', 'answer', 'ice'].includes(event.kind));
    assert.equal(typeof event.payload, 'string');
    write(`${side}-in-${String(received[side] + 1).padStart(6, '0')}.json`,
      { seq, revision: event.revision, kind: event.kind, payload: event.payload, from_user_id: id(event.from_user_id) });
    received[side]++; cursors[side] = seq;
  }
  const next = id(page.next_seq);
  assert.ok(BigInt(next) >= BigInt(cursors[side])); cursors[side] = next;
}
try {
  await login('caller', 'owner', 'web'); await login('callee', 'admin', 'macos');
  const direct = await sessions.caller!.client.channelDirectGetOrCreate(raw(sessions.callee!.uid) as any, 'friend');
  assert.equal(id(direct.channel_id), id(group.directChannelId));
  for (const side of sides) assert.deepEqual((await rpc(side, 'call/active')).calls, [], 'do not disrupt another active call');
  const capabilities = await rpc('caller', 'call/capabilities');
  assert.equal(capabilities.enabled, true); assert.equal(capabilities.peer_enabled, true);
  phase = 'invite-join';
  const invited = await rpc('caller', 'call/invite', { command_id: randomUUID(), channel_id: raw(group.directChannelId), media_kind: 'video', supports_peer: true });
  callId = id(invited.call.call_id); assert.equal(typeof invited.call.call_id, 'string');
  const callee = await rpc('callee', 'call/join', mutation());
  const caller = await rpc('caller', 'call/join', mutation());
  assert.equal(caller.call.transport, 'webrtc'); assert.equal(callee.call.transport, 'webrtc');
  assert.equal(caller.token, ''); assert.equal(callee.token, '');
  await heartbeat();
  write('peer-ready.json', { callId, caller: peer(caller.peer, 'caller'), callee: peer(callee.peer, 'callee') });
  console.log(`CALL_NATIVE_EXCHANGE_DIR=${directory}`);
  console.log(`BROKER_CONTROL_DIR=${control}`);
  if (mode === '--dry-run') {
    // Cross a full rate bucket with real RPCs; never synthesize SDP/native-done.
    const until = Date.now() + 12000;
    let nextHeartbeat = Date.now() + 10000;
    do {
      assert.ok(!stopped && !existsSync(`${control}/stop`), 'dry-run interrupted');
      for (const side of sides) await pump(side);
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + 10000; }
      await sleep(400);
    } while (Date.now() < until);
    completed = true;
  } else {
    phase = 'native-exchange';
    let nextHeartbeat = Date.now() + 10000;
    while (!stopped && !existsSync(`${control}/stop`) && Date.now() - started < timeout) {
      for (const side of sides) await pump(side);
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + 10000; }
      const done = read('native-done.json');
      if (done) {
        assert.equal(done.ok, true, 'native test reported failure');
        assert.ok(sides.every(side => sent[side] > 0 && received[side] > 0));
        assert.ok(done.callerDecodedFrames >= 3 && done.calleeDecodedFrames >= 3);
        assert.ok(Array.isArray(done.videoBytes) && done.videoBytes.length === 2 &&
          done.videoBytes.every((v: Json) => v.sent > 0 && v.received > 0));
        nativeResult = { ok: true, callerRoute: done.callerRoute, calleeRoute: done.calleeRoute,
          callerDecodedFrames: done.callerDecodedFrames, calleeDecodedFrames: done.calleeDecodedFrames, videoBytes: done.videoBytes };
        completed = true; break;
      }
      // Server journal reads allow 40/10s per user; stay below that budget.
      await sleep(400);
    }
    assert.ok(completed, stopped ? 'broker interrupted' : 'native completion timeout');
  }
} catch (error) {
  failure = { phase, kind: error instanceof Error ? error.name : 'Unknown',
    ...(error instanceof RpcError ? { code: error.response.code, route: error.route,
      rateLimited: error.response.message === 'Peer signalling rate limit; retry later' } : {}) };
} finally {
  if (callId) {
    cleanup = 'failed';
    try {
      const current = await rpc('caller', 'call/get', { call_id: raw(callId) });
      if (current.call.state !== 'ended') await rpc('caller', current.call.state === 'ringing' ? 'call/cancel' : 'call/end', mutation());
      assert.equal((await rpc('caller', 'call/get', { call_id: raw(callId) })).call.state, 'ended');
      cleanup = 'ended-via-rpc';
    } catch { completed = false; }
  }
  await Promise.all(Object.values(sessions).map(s => s!.client.disconnect().catch(() => undefined)));
  const success = completed && !failure && cleanup === 'ended-via-rpc';
  const report = { success, mode, fixture: root, sourceSha256, binarySha256, callId,
    durationMs: Date.now() - started, sent, received, heartbeatCounts, cleanup, failure, nativeResult,
    nativeFramesClaimed: mode === '--serve' && success && nativeResult !== undefined,
    restartClaimed: false, boundary: 'TS replaces Kotlin as sole inbound writer. Frozen Swift IM branch returns before ICE restart. No Publish/SQL/native source changes.' };
  writeFileSync(`${control}/broker-report.json`, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  if (existsSync(directory)) write('broker-report.json', report);
  console.log(`${success ? 'CARRIER_PASS' : 'CARRIER_FAIL'} mode=${mode}; report=${control}/broker-report.json`);
  if (!success) process.exitCode = 1;
}
