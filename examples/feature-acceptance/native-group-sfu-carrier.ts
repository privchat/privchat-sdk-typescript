// Real RPC-issued three-user group authority. Native media is claimed only with bound frame evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { PrivchatClient, RpcError, parseRpcJson } from '../../src/index.js';
import { RawU64 } from '../../src/codec/safe-json.js';
import { assertPrivateFixtureRoot } from './fixture.js';
import { bounded } from './native-carrier-watchdog.js';
import { validateNativeGroupResult, validateNativeXCTestSummary, type NativeGroupResult } from './group-sfu-contract.js';

type Json = Record<string, any>;
type Role = 'owner' | 'admin' | 'member';
const mode = process.argv[2];
assert.ok(mode === '--serve' || mode === '--authority-only', 'explicit acceptance mode required');
const root = process.env.PRIVCHAT_FEATURE_ROOT;
assertPrivateFixtureRoot(root);
const fixture = JSON.parse(readFileSync(`${root}/public.json`, 'utf8'));
assert.equal(fixture.wsPort, 58610, 'only the separately owned secondary fixture is authorized');
const authorization = JSON.parse(readFileSync(`${root}/call-restart-authorized.json`, 'utf8'));
assert.equal(authorization.root, root);
assert.equal(authorization.purpose, 'isolated-call-restart-authority');
const binarySha256 = createHash('sha256').update(readFileSync(`${root}/server-bin`)).digest('hex');
assert.equal(authorization.binarySha256, binarySha256);
for (const file of ['accounts.json', 'group.json']) assert.equal(statSync(`${root}/${file}`).mode & 0o077, 0);
const accounts = parseRpcJson<Json>(readFileSync(`${root}/accounts.json`, 'utf8'));
const group = parseRpcJson<Json>(readFileSync(`${root}/group.json`, 'utf8'));
const runId = randomUUID();
const directory = resolve(root, '..', mode === '--serve' ? 'group-sfu-carrier' : `group-sfu-authority-${runId}`);
assert.equal(statSync(resolve(root, '..')).mode & 0o077, 0);
mkdirSync(directory, { mode: 0o700 }); // Never reuse stale native evidence or overwrite another broker.
const credentialPath = `${directory}/group-sfu-credentials.json`, resultPath = `${directory}/group-sfu-native-result.json`;
const completionPath = `${directory}/group-sfu-native-completion.json`;
const sourceSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const contractSha256 = createHash('sha256').update(readFileSync(new URL('./group-sfu-contract.ts', import.meta.url))).digest('hex');
const timeout = Number(process.env.PRIVCHAT_GROUP_SFU_TIMEOUT_MS ?? 240000);
assert.ok(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 240000);
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), timeout);
process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort());
const started = Date.now(), sessions: Session[] = [], violations: string[] = [];
let phase = 'login', callId: string | undefined, inviteRequest: Json | undefined;
let nativeResult: NativeGroupResult | undefined, complete = false, cleanup = 'not-needed', success = false;
let nativeXCTest: ReturnType<typeof validateNativeXCTestSummary> | undefined, xcresultPath: string | undefined;
let cleaning = false, cleanupUntil = Infinity, failure: Json | undefined;
interface Session { client: PrivchatClient; uid: string; role: Role; authenticated: boolean; heartbeats: number }
const raw = (id: unknown) => { assert.match(String(id), /^\d+$/); return new RawU64(String(id)); };
const mutation = () => ({ call_id: raw(callId), command_id: randomUUID(), supports_peer: true });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function write(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(tmp, file);
}
async function rpc(session: Session, route: string, body: Json = {}): Promise<Json> {
  return bounded(route, () => session.client.rpcCallTyped<Json, Json>(route, body, { timeoutMs: 10000 }),
    Math.max(1, Math.min(10000, cleaning ? cleanupUntil - Date.now() : timeout - (Date.now() - started))),
    cleaning ? undefined : abort.signal);
}
async function login(role: Role) {
  const client = new PrivchatClient({ url: `ws://127.0.0.1:${fixture.wsPort}/gate`, defaultTimeoutMs: 10000,
    defaultDeviceInfo: { device_type: 'web', app_id: `native-group-${role}`, device_name: 'Private group SFU acceptance' } });
  const session: Session = { client, uid: '', role, authenticated: false, heartbeats: 0 }; sessions.push(session);
  client.observeEvents(({ event }) => {
    if (event.type === 'channel_publish_received' && event.topic.startsWith('call/')) violations.push('call used Publish');
  });
  await bounded('connect', () => client.connect(), 10000, abort.signal);
  const device = randomUUID();
  const auth = await rpc(session, 'account/auth/login', { username: accounts[role].username,
    password: accounts[role].password, device_id: device,
    device_info: { device_id: device, device_type: 'web', app_id: `native-group-${role}`, device_name: 'Private group SFU acceptance' } });
  session.uid = String(auth.user_id); assert.equal(session.uid, String(accounts[role].user_id));
  await bounded('authenticate', () => client.authenticate(session.uid, auth.token, device), 10000, abort.signal);
  session.authenticated = true;
  return session;
}
async function heartbeat() {
  for (const session of sessions) {
    const response = await rpc(session, 'call/heartbeat', mutation());
    assert.equal(response.call.state, 'active'); session.heartbeats++;
  }
}
try {
  for (const role of ['owner', 'admin', 'member'] as const) await login(role);
  const owner = sessions[0]!;
  const capabilities = await rpc(owner, 'call/capabilities');
  assert.equal(capabilities.livekit_enabled, true);
  for (const session of sessions) assert.deepEqual((await rpc(session, 'call/active')).calls, []);
  phase = 'invite-and-three-rpc-joins';
  inviteRequest = { command_id: randomUUID(), channel_id: raw(group.channelId),
    media_kind: 'video', invitee_ids: sessions.slice(1).map(s => raw(s.uid)), supports_peer: true };
  const invited = await rpc(owner, 'call/invite', inviteRequest); callId = String(invited.call.call_id);
  const joins: Json[] = [], identities: string[] = [];
  for (const session of sessions) {
    const joined = await rpc(session, 'call/join', mutation());
    assert.equal(joined.call.transport, 'livekit'); assert.equal(joined.peer, null);
    assert.equal(joined.url, 'ws://127.0.0.1:56780');
    assert.ok(Number(joined.expires_at_ms) - Date.now() >= 280000, 'private server must issue 300-second tokens before launch');
    // Decode only to bind server-issued identities; authentication is exercised by native SFU connection.
    const claims = JSON.parse(Buffer.from(joined.token.split('.')[1], 'base64url').toString());
    assert.equal(claims.video.room, `pc-${group.channelId}-${callId}`);
    assert.equal(claims.video.roomJoin, true); assert.equal(claims.video.canPublish, true);
    assert.deepEqual(claims.video.canPublishSources, ['microphone', 'camera']);
    assert.match(claims.sub, /^[a-f0-9]{64}$/); identities.push(claims.sub); joins.push(joined);
  }
  assert.equal(new Set(identities).size, 3);
  await heartbeat();
  const snapshot = (await rpc(owner, 'call/get', { call_id: raw(callId) })).call;
  assert.equal(snapshot.state, 'active');
  assert.ok(snapshot.participants.length === 3 && snapshot.participants.every((p: Json) => p.state === 'joined'));
  if (mode === '--serve') {
    const expectedPeerIdentities = identities.slice(1);
    write(credentialPath, { url: joins[0]!.url, token: joins[0]!.token, peerToken: joins[1]!.token,
      secondPeerToken: joins[2]!.token, callId, runId, expectedPeerIdentities,
      room: `pc-${group.channelId}-${callId}`, secondPeerIdentity: identities[2],
      expiresAtMs: Math.min(...joins.map(j => Number(j.expires_at_ms))) });
    phase = 'await-native-evidence';
    console.log(`GROUP_SFU_READY credentials=${credentialPath} result=${resultPath}`);
    let nextHeartbeat = Date.now() + 5000;
    while (!abort.signal.aborted) {
      if (!nativeResult && existsSync(resultPath)) {
        const stat = lstatSync(resultPath); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
        nativeResult = validateNativeGroupResult(JSON.parse(readFileSync(resultPath, 'utf8')),
          `pc-${group.channelId}-${callId}`, callId!, expectedPeerIdentities);
      }
      // Frame proof is emitted before teardown. Wait for the focused XCTest's
      // completed result before ending the room underneath its remaining checks.
      if (nativeResult && existsSync(completionPath)) {
        const stat = lstatSync(completionPath); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
        const completion = JSON.parse(readFileSync(completionPath, 'utf8'));
        assert.equal(completion.callId, callId);
        assert.ok(typeof completion.xcresultPath === 'string' && completion.xcresultPath.endsWith('.xcresult'));
        xcresultPath = realpathSync(completion.xcresultPath);
        const artifacts = resolve(root, '..', '..'), child = relative(artifacts, xcresultPath!);
        assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
        const summary = JSON.parse(execFileSync('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', xcresultPath!],
          { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }));
        nativeXCTest = validateNativeXCTestSummary(summary, started);
        break;
      }
      if (Date.now() >= nextHeartbeat) { await heartbeat(); nextHeartbeat = Date.now() + 5000; }
      assert.equal(violations.length, 0);
      await sleep(200);
    }
    assert.ok(nativeResult && nativeXCTest, 'native completion was not observed before expiration or cancellation');
  }
  complete = true;
} catch (error) {
  failure = { phase, kind: error instanceof Error ? error.name : 'Unknown',
    ...(error instanceof RpcError ? { route: error.route, code: error.response.code } : {}) };
} finally {
  phase = 'terminal-rpc-cleanup'; cleaning = true; cleanupUntil = Date.now() + 30000; clearTimeout(timer);
  try {
    const owner = sessions[0];
    if (!callId && inviteRequest && owner?.authenticated) callId = String((await rpc(owner, 'call/invite', inviteRequest)).call.call_id);
    if (callId && owner) {
      const current = await rpc(owner, 'call/get', { call_id: raw(callId) });
      if (current.call.state !== 'ended') await rpc(owner, current.call.state === 'ringing' ? 'call/cancel' : 'call/end', mutation());
      assert.equal((await rpc(owner, 'call/get', { call_id: raw(callId) })).call.state, 'ended');
      for (const session of sessions) assert.ok(!(await rpc(session, 'call/active')).calls.some((call: Json) => String(call.call_id) === callId));
      cleanup = 'ended-via-rpc';
    }
  } catch { cleanup = 'rpc-cleanup-failed'; }
  const disconnectFailures: Role[] = [];
  for (const session of sessions) {
    try { await bounded('disconnect', () => session.client.disconnect(), 5000); }
    catch { disconnectFailures.push(session.role); }
  }
  if (existsSync(credentialPath)) unlinkSync(credentialPath);
  success = complete && cleanup === 'ended-via-rpc' && !disconnectFailures.length && !violations.length;
  write(`${directory}/broker-report.json`, { success, mode, runId, callId, fixture: root, binarySha256,
    sourceSha256, contractSha256, durationMs: Date.now() - started,
    heartbeatCounts: Object.fromEntries(sessions.map(s => [s.role, s.heartbeats])), nativeResult, nativeXCTest, xcresultPath,
    cleanup, disconnectFailures, violations, failure, credentialsRemoved: !existsSync(credentialPath),
    nativeFramesClaimed: mode === '--serve' && success && nativeResult !== undefined && nativeXCTest !== undefined,
    boundary: 'Real three-user SDK RPC group joins; native media only with bound two-stream frame evidence. No manual JWT, Publish, hardware camera or full CallUI claim.' });
  console.log(`${success ? 'GROUP_SFU_PASS' : 'GROUP_SFU_FAIL'} mode=${mode} report=${directory}/broker-report.json`);
  if (!success) process.exitCode = 1;
}
