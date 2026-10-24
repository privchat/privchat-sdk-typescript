// Test-only replacement for the Kotlin file carrier; never run both in one directory.
// Set PRIVCHAT_FEATURE_ROOT to a private project-local disposable fixture; pass --dry-run|--serve.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { PrivchatClient, RpcError, parseRpcJson } from '../../src/index.js';
import { RawU64 } from '../../src/codec/safe-json.js';
import { assertPrivateFixtureRoot } from './fixture.js';
import { bounded, CarrierFailure, ExchangeLocator } from './native-carrier-watchdog.js';

type Json = Record<string, any>;
type Side = 'caller' | 'callee';
const sides: Side[] = ['caller', 'callee'];
const mode = process.argv[2];
assert.ok(mode === '--dry-run' || mode === '--serve', 'explicit --dry-run or --serve required');
const root = process.env.PRIVCHAT_FEATURE_ROOT;
assertPrivateFixtureRoot(root);
for (const name of ['accounts.json', 'group.json']) {
  assert.equal(statSync(`${root}/${name}`).mode & 0o077, 0, 'private fixture inputs required');
}
const fixture = parseRpcJson<Json>(readFileSync(`${root}/public.json`, 'utf8'));
const accounts = parseRpcJson<Json>(readFileSync(`${root}/accounts.json`, 'utf8'));
const group = parseRpcJson<Json>(readFileSync(`${root}/group.json`, 'utf8'));
assert.equal(fixture.host, '127.0.0.1');
const binarySha256 = createHash('sha256').update(readFileSync(`${root}/server-bin`)).digest('hex');
const timeout = Number(process.env.PRIVCHAT_NATIVE_TIMEOUT_MS ?? 600000);
assert.ok(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 1200000);
const rpcTimeout = Number(process.env.PRIVCHAT_NATIVE_RPC_TIMEOUT_MS ?? 10000);
const cleanupTimeout = Number(process.env.PRIVCHAT_NATIVE_CLEANUP_TIMEOUT_MS ?? 30000);
assert.ok(Number.isSafeInteger(rpcTimeout) && rpcTimeout >= 100 && rpcTimeout <= 30000);
assert.ok(Number.isSafeInteger(cleanupTimeout) && cleanupTimeout >= 1000 && cleanupTimeout <= 60000);
assert.ok(['0', '1'].includes(process.env.PRIVCHAT_NATIVE_FOLLOW_CONTAINER_MOVE ?? '0'));
const parent = process.env.PRIVCHAT_NATIVE_EXCHANGE_PARENT ?? root;
if (parent !== root) {
  assert.match(parent, /^\/Users\/[^/]+\/Library\/Developer\/CoreSimulator\/Devices\/[A-Fa-f0-9-]+\/data\/Containers\/Data\/Application\/[A-Fa-f0-9-]+\/Documents$/);
  assert.equal(realpathSync(parent), parent, 'canonical simulator Documents directory required');
  assert.equal(statSync(parent).uid, process.getuid!());
}
const exchangeName = process.env.PRIVCHAT_NATIVE_EXCHANGE_NAME;
if (exchangeName !== undefined) {
  assert.match(exchangeName, /^privchat-native-peer-[A-Za-z0-9-]{8,64}$/);
}
const directory = exchangeName === undefined ? mkdtempSync(`${parent}/privchat-native-peer-ts.`) : `${parent}/${exchangeName}`;
if (exchangeName !== undefined) mkdirSync(directory, { mode: 0o700 });
assert.equal(lstatSync(directory).mode & 0o777, 0o700);
// Keep cancellation/evidence outside a simulator container that Xcode may delete.
const control = mkdtempSync(`${root}/privchat-native-peer-control.`);
writeFileSync(`${control}/pid`, String(process.pid), { mode: 0o600, flag: 'wx' });
writeFileSync(`${directory}/broker.lock`, String(process.pid), { mode: 0o600, flag: 'wx' });
const exchange = new ExchangeLocator(directory, process.env.PRIVCHAT_NATIVE_FOLLOW_CONTAINER_MOVE === '1');
const sourceSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const watchdogSourceSha256 = createHash('sha256').update(readFileSync(new URL('./native-carrier-watchdog.ts', import.meta.url))).digest('hex');
console.log(`BROKER_CONTROL_DIR=${control}`);
const id = (value: unknown): string => {
  assert.ok(typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)), 'unsafe ID');
  const result = String(value); assert.match(result, /^\d+$/); return result;
};
const raw = (value: unknown) => new RawU64(id(value));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function write(name: string, value: Json) {
  const target = `${exchange.ensure()}/${name}`, temp = `${target}.${randomUUID()}.tmp`;
  assert.ok(!existsSync(target), 'exchange files must not be overwritten');
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temp, target);
}
function read(name: string): Json | undefined {
  const file = `${exchange.ensure()}/${name}`;
  if (!existsSync(file)) return undefined;
  const entry = lstatSync(file);
  assert.ok(entry.isFile() && !entry.isSymbolicLink(), 'regular exchange file required');
  // Swift atomically writes then chmods: wait for its private mode before opening.
  if ((entry.mode & 0o077) !== 0) return undefined;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 262144);
    assert.equal(stat.uid, process.getuid!());
    assert.equal(stat.mode & 0o077, 0);
    return parseRpcJson<Json>(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
interface Session { client: PrivchatClient; uid: string }
const sessions: Partial<Record<Side, Session>> = {};
const sent = { caller: 0, callee: 0 }, received = { caller: 0, callee: 0 };
const cursors = { caller: '0', callee: '0' };
const heartbeatCounts = { caller: 0, callee: 0 };
let phase = 'login', callId: string | undefined, completed = false, stopped = false;
let nativeResult: Json | undefined, failure: Json | undefined, cleanup = 'not-needed';
let cleanupFailure: Json | undefined, disconnectFailures: Json[] = [];
let cleaningUp = false, finalized = false, cleanupUntil = Infinity;
let inviteRequest: Json | undefined, activeOperation = 'starting';
const started = Date.now();
const runAbort = new AbortController();
function status(operation: string, outcome: string) {
  activeOperation = operation;
  // Fixed phases, routes and counters only. Never request bodies, SDP or provider errors.
  const value = { at: new Date().toISOString(), phase, operation, outcome, callId,
    durationMs: Date.now() - started, sent, received, heartbeatCounts,
    exchangeDirectory: exchange.current, exchangeMoves: exchange.moves };
  const path = `${control}/status.json`, temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
  appendFileSync(`${control}/phases.jsonl`, JSON.stringify(value) + '\n', { mode: 0o600 });
}
function safeFailure(error: unknown): Json {
  return { phase, kind: error instanceof Error ? error.name : 'Unknown',
    ...(error instanceof CarrierFailure ? { reason: error.code } : {}),
    ...(error instanceof RpcError ? { code: error.response.code, route: error.route,
      rateLimited: error.response.message === 'Peer signalling rate limit; retry later' } : {}) };
}
async function operation<T>(label: string, work: () => Promise<T>, limit = rpcTimeout): Promise<T> {
  if (finalized) throw new CarrierFailure('ALREADY_FINALIZED');
  if (cleaningUp && Date.now() >= cleanupUntil) throw new CarrierFailure('CLEANUP_DEADLINE');
  status(label, 'begin');
  try {
    const result = await bounded(label, work, Math.max(1, Math.min(limit, cleaningUp ? cleanupUntil - Date.now() : limit)), cleaningUp ? undefined : runAbort.signal);
    status(label, 'returned');
    return result;
  } catch (error) { status(label, 'failed'); throw error; }
}
function makeReport(success: boolean) {
  return { success, mode, fixture: root, sourceSha256, watchdogSourceSha256, binarySha256, callId,
    durationMs: Date.now() - started, sent, received, heartbeatCounts, cleanup, cleanupFailure, disconnectFailures,
    failure, nativeResult, activeOperation, exchangeDirectory: exchange.current, originalExchangeDirectory: directory,
    exchangeMoves: exchange.moves, exchangeReportWritten: true, limits: { timeout, rpcTimeout, cleanupTimeout },
    nativeFramesClaimed: mode === '--serve' && success && nativeResult !== undefined,
    restartClaimed: false, boundary: 'TS replaces Kotlin as sole inbound writer. Native execution is claimed only with validated native completion. No Publish/SQL/production native changes.' };
}
const runTimer = setTimeout(() => runAbort.abort(), timeout);
const hardTimer = setTimeout(() => {
  failure ??= { phase, kind: 'CarrierFailure', reason: 'FINALIZATION_WATCHDOG' };
  try { writeFileSync(`${control}/broker-report.json`, JSON.stringify(makeReport(false)), { mode: 0o600, flag: 'wx' }); } finally { process.exit(1); }
}, timeout + cleanupTimeout + 6000);
process.once('SIGTERM', () => { stopped = true; runAbort.abort(); });
process.once('SIGINT', () => { stopped = true; runAbort.abort(); });
const rpc = async (side: Side, route: string, body: Json = {}): Promise<Json> => {
  const session = sessions[side]; assert.ok(session);
  for (let attempt = 0; ; attempt++) {
    try { return await operation(`${side}:${route}`, () => session.client.rpcCallTyped<Json, Json>(route, body, { timeoutMs: rpcTimeout })); }
    catch (error) {
      if (cleaningUp || stopped || runAbort.signal.aborted || !(error instanceof RpcError) || !route.startsWith('call/peer/') || attempt >= 10 ||
          error.response.code !== 10100 || error.response.message !== 'Peer signalling rate limit; retry later') throw error;
      await operation('rate-limit-backoff', () => sleep(1000));
    }
  }
};
async function login(side: Side, role: 'owner' | 'admin', platform: 'web' | 'macos') {
  const client = new PrivchatClient({ url: `ws://127.0.0.1:${fixture.wsPort}/gate`, defaultTimeoutMs: 10000,
    defaultDeviceInfo: { device_type: platform, app_id: `native-peer-ts-${side}`, device_name: 'Private native peer acceptance' } });
  sessions[side] = { client, uid: '' };
  await operation(`${side}:connect`, () => client.connect());
  const device = randomUUID();
  const auth = await rpc(side, 'account/auth/login', { username: accounts[role].username, password: accounts[role].password,
    device_id: device, device_info: { device_id: device, device_type: platform,
      app_id: `native-peer-ts-${side}`, device_name: 'Private native peer acceptance' } });
  sessions[side]!.uid = id(auth.user_id);
  assert.equal(id(auth.user_id), id(accounts[role].user_id));
  await operation(`${side}:authenticate`, () => client.authenticate(id(auth.user_id), auth.token, device));
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
  const direct = await operation('caller:channelDirectGetOrCreate', () => sessions.caller!.client.channelDirectGetOrCreate(raw(sessions.callee!.uid) as any, 'friend'));
  assert.equal(id(direct.channel_id), id(group.directChannelId));
  for (const side of sides) assert.deepEqual((await rpc(side, 'call/active')).calls, [], 'do not disrupt another active call');
  const capabilities = await rpc('caller', 'call/capabilities');
  assert.equal(capabilities.enabled, true); assert.equal(capabilities.peer_enabled, true);
  phase = 'invite-join';
  inviteRequest = { command_id: randomUUID(), channel_id: raw(group.directChannelId), media_kind: 'video', supports_peer: true };
  let invited: Json;
  try { invited = await rpc('caller', 'call/invite', inviteRequest); }
  catch (error) { if (error instanceof RpcError) inviteRequest = undefined; throw error; }
  callId = id(invited.call.call_id); assert.equal(typeof invited.call.call_id, 'string');
  const callee = await rpc('callee', 'call/join', mutation());
  const caller = await rpc('caller', 'call/join', mutation());
  assert.equal(caller.call.transport, 'webrtc'); assert.equal(callee.call.transport, 'webrtc');
  assert.equal(caller.token, ''); assert.equal(callee.token, '');
  await heartbeat();
  write('peer-ready.json', { callId, caller: peer(caller.peer, 'caller'), callee: peer(callee.peer, 'callee') });
  exchange.bindReady();
  console.log(`CALL_NATIVE_EXCHANGE_DIR=${exchange.current}`);
  if (mode === '--dry-run') {
    // Cross a full rate bucket with real RPCs; never synthesize SDP/native-done.
    const until = Date.now() + 12000;
    let nextHeartbeat = Date.now() + 10000;
    do {
      assert.ok(!stopped && !existsSync(`${control}/stop`), 'dry-run interrupted');
      for (const side of sides) await pump(side);
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + 10000; }
      await operation('poll-wait', () => sleep(400));
    } while (Date.now() < until);
    completed = true;
  } else {
    phase = 'native-exchange';
    let nextHeartbeat = Date.now() + 10000;
    while (!stopped && !existsSync(`${control}/stop`) && Date.now() - started < timeout) {
      const done = read('native-done.json');
      if (done) {
        if (done.ok !== true) throw new CarrierFailure('NATIVE_REPORTED_FAILURE');
        assert.ok(sides.every(side => sent[side] > 0 && received[side] > 0));
        assert.ok(done.callerDecodedFrames >= 3 && done.calleeDecodedFrames >= 3);
        assert.ok(['direct', 'relay', 'unknown'].includes(done.callerRoute) && ['direct', 'relay', 'unknown'].includes(done.calleeRoute));
        assert.ok(Array.isArray(done.videoBytes) && done.videoBytes.length === 2 &&
          done.videoBytes.every((v: Json) => v.sent > 0 && v.received > 0));
        nativeResult = { ok: true, callerRoute: done.callerRoute, calleeRoute: done.calleeRoute,
          callerDecodedFrames: done.callerDecodedFrames, calleeDecodedFrames: done.calleeDecodedFrames,
          videoBytes: done.videoBytes.map((v: Json) => ({ sent: v.sent, received: v.received })) };
        completed = true; break;
      }
      for (const side of sides) await pump(side);
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + 10000; }
      // Server journal reads allow 40/10s per user; stay below that budget.
      await operation('poll-wait', () => sleep(400));
    }
    if (!completed) throw new CarrierFailure(stopped || existsSync(`${control}/stop`) ? 'BROKER_INTERRUPTED' : 'NATIVE_COMPLETION_TIMEOUT');
  }
} catch (error) {
  failure = safeFailure(error);
} finally {
  clearTimeout(runTimer);
  cleaningUp = true;
  phase = 'cleanup';
  cleanupUntil = Date.now() + cleanupTimeout;
  try {
    // Replay only our own idempotent invite when its response was lost; never end arbitrary active calls.
    if (!callId && inviteRequest) {
      const invited = await rpc('caller', 'call/invite', inviteRequest);
      callId = id(invited.call.call_id);
    }
    if (callId) {
      cleanup = 'pending';
      const current = await rpc('caller', 'call/get', { call_id: raw(callId) });
      if (current.call.state !== 'ended') await rpc('caller', current.call.state === 'ringing' ? 'call/cancel' : 'call/end', mutation());
      assert.equal((await rpc('caller', 'call/get', { call_id: raw(callId) })).call.state, 'ended');
      cleanup = 'ended-via-rpc';
    }
  } catch (error) { cleanup = 'failed'; cleanupFailure = safeFailure(error); completed = false; }
  phase = 'disconnect';
  await Promise.all(Object.entries(sessions).map(async ([side, session]) => {
    try { await bounded(`${side}:disconnect`, () => session!.client.disconnect(), 3000); }
    catch (error) { disconnectFailures.push({ side, ...safeFailure(error) }); }
  }));
  const success = completed && !failure && cleanup === 'ended-via-rpc' && disconnectFailures.length === 0;
  phase = 'finished';
  finalized = true;
  status('report', success ? 'pass' : 'fail');
  const report = makeReport(success);
  // The control report is authoritative and must not depend on a surviving simulator directory.
  try { write('broker-report.json', report); } catch { report.exchangeReportWritten = false; }
  writeFileSync(`${control}/broker-report.json`, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  clearTimeout(hardTimer);
  console.log(`${success ? 'CARRIER_PASS' : 'CARRIER_FAIL'} mode=${mode}; report=${control}/broker-report.json`);
  process.exitCode = success ? 0 : 1;
  // A timed-out SDK disconnect may retain transport handles; the report is already durable.
  setTimeout(() => process.exit(success ? 0 : 1), 250).unref();
}
