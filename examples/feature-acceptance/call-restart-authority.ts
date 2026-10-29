// Real loopback acceptance. Restart only a separately authorized disposable fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PrivchatClient, parseRpcJson, RpcError } from '../../src/index.js';
import { RawU64 } from '../../src/codec/safe-json.js';
import { assertPrivateFixtureRoot } from './fixture.js';

type Json = Record<string, any>;
const root = process.env.PRIVCHAT_FEATURE_ROOT;
assertPrivateFixtureRoot(root);
assert.equal(process.argv[2], '--allow-owned-fixture-restart');
const fixture = parseRpcJson<Json>(readFileSync(`${root}/public.json`, 'utf8'));
const authorization = JSON.parse(readFileSync(`${root}/call-restart-authorized.json`, 'utf8'));
assert.equal(statSync(`${root}/call-restart-authorized.json`).mode & 0o077, 0);
assert.equal(authorization.root, root);
assert.equal(authorization.binarySha256, readFileSync(`${root}/binary.sha256`, 'utf8').split(/\s+/)[0]);
assert.equal(authorization.purpose, 'isolated-call-restart-authority');
const accounts = parseRpcJson<Json>(readFileSync(`${root}/accounts.json`, 'utf8'));
const group = parseRpcJson<Json>(readFileSync(`${root}/group.json`, 'utf8'));
const raw = (value: unknown) => new RawU64(String(value));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const checks: string[] = [], clients: Endpoint[] = [], ownedCalls: string[] = [];
const violations: string[] = [];
let restartCount = 0, phase = 'login', success = false;
interface Endpoint { client: PrivchatClient; uid: string; device: string; token: string; states: Json[] }
async function eventually<T>(probe: () => Promise<T | undefined>, ms = 25000): Promise<T> {
  const until = Date.now() + ms;
  do { const value = await probe(); if (value !== undefined) return value; await sleep(150); } while (Date.now() < until);
  throw new Error(`Timed out during ${phase}`);
}
const rpc = (e: Endpoint, route: string, body: Json = {}) => e.client.rpcCallTyped<Json, Json>(route, body);
const mutation = (id: string) => ({ call_id: raw(id), command_id: randomUUID(), supports_peer: true });
async function login(role: 'owner' | 'admin' | 'member'): Promise<Endpoint> {
  const client = new PrivchatClient({ url: `ws://127.0.0.1:${fixture.wsPort}/gate`, defaultTimeoutMs: 10000,
    defaultDeviceInfo: { device_type: 'web', app_id: `restart-${role}`, device_name: 'Isolated call authority' } });
  const endpoint: Endpoint = { client, uid: '', device: randomUUID(), token: '', states: [] };
  clients.push(endpoint);
  client.observeEvents(({ event }) => {
    if (event.type === 'channel_publish_received' && event.topic.startsWith('call/')) violations.push('call state used Publish');
    if (event.type === 'rpc_notification_received' && event.route === 'call/state') {
      endpoint.states.push(parseRpcJson<Json>(new TextDecoder().decode(event.body)));
    }
  });
  await client.connect();
  const auth = await rpc(endpoint, 'account/auth/login', { username: accounts[role].username,
    password: accounts[role].password, device_id: endpoint.device,
    device_info: { device_id: endpoint.device, device_type: 'web', app_id: `restart-${role}`, device_name: 'Isolated call authority' } });
  endpoint.uid = String(auth.user_id); endpoint.token = auth.token;
  await client.authenticate(endpoint.uid, endpoint.token, endpoint.device);
  return endpoint;
}
function listener(): number | undefined {
  try {
    const pids = execFileSync('lsof', ['-nP', `-iTCP:${fixture.wsPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    assert.equal(pids.length, 1); return Number(pids[0]);
  } catch (error) { if ((error as { status?: number }).status === 1) return undefined; throw error; }
}
async function stopOwnedServer() {
  const pid = listener(); assert.ok(pid);
  assert.equal(pid, Number(readFileSync(`${root}/server.pid`, 'utf8')));
  const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  assert.ok(command.includes(`${root}/server-bin`) && command.includes(`${root}/config.toml`), 'never stop an unrelated process');
  await Promise.all(clients.map(e => e.client.disconnect()));
  process.kill(pid, 'SIGTERM');
  await eventually(async () => listener() === undefined ? true : undefined);
}
async function startOwnedServer() {
  assert.equal(listener(), undefined);
  const fd = openSync(`${root}/server.log`, 'a', 0o600);
  const child = spawn(`${root}/server-bin`, ['--config-file', `${root}/config.toml`, '--env', 'test'], {
    cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env,
      DATABASE_URL: `postgres://${process.env.USER}@127.0.0.1:5432/${fixture.database}`,
      REDIS_URL: `redis://127.0.0.1:${fixture.redisPort}`,
      SERVICE_MASTER_KEY: readFileSync(`${root}/master-key`, 'utf8').trim() } });
  child.unref(); closeSync(fd);
  writeFileSync(`${root}/launcher.pid`, String(child.pid), { mode: 0o600 });
  const pid = await eventually(async () => listener());
  writeFileSync(`${root}/server.pid`, String(pid), { mode: 0o600 });
  restartCount++;
  for (const e of clients) { await e.client.connect(); await e.client.authenticate(e.uid, e.token, e.device); }
}
async function summaries(e: Endpoint, id: string): Promise<Json[]> {
  const history = await e.client.messageHistory(String(group.directChannelId), 100);
  return history.messages.filter(message => {
    try { const body = parseRpcJson<Json>(message.content); return body.event === 'call.ended' && String(body.call_id) === id; }
    catch { return false; }
  });
}
try {
  const owner = await login('owner'), callee = await login('admin');
  for (const e of clients) assert.deepEqual((await rpc(e, 'call/active')).calls, []);
  const capabilities = await rpc(owner, 'call/capabilities');
  assert.equal(capabilities.peer_enabled, true);
  const invite = () => rpc(owner, 'call/invite', { command_id: randomUUID(), channel_id: raw(group.directChannelId), media_kind: 'video', supports_peer: true });
  const id = String((await invite()).call.call_id); ownedCalls.push(id);
  const accepted = await rpc(callee, 'call/join', mutation(id));
  const ownerJoin = mutation(id);
  const joined = await rpc(owner, 'call/join', ownerJoin);
  for (const response of [accepted, joined]) {
    assert.equal(response.call.transport, 'webrtc'); assert.equal(response.token, '');
    assert.equal(response.peer.credential_expires_at_ms, 0);
    assert.ok(response.peer.ice_servers.every((s: Json) => s.urls.every((url: string) => /^stun:/.test(url))));
  }
  const offer = { ...mutation(id), revision: 1, kind: 'offer', payload: 'v=0\r\ns=private-restart-authority\r\n' };
  await rpc(owner, 'call/peer/signal', offer);
  const journal = await rpc(callee, 'call/peer/events', { call_id: raw(id), after_seq: 0 });
  await Promise.all(clients.map(e => rpc(e, 'call/heartbeat', mutation(id))));
  phase = 'active-server-restart';
  await stopOwnedServer(); await startOwnedServer();
  assert.equal((await rpc(owner, 'call/get', { call_id: raw(id) })).call.state, 'active');
  assert.ok((await rpc(callee, 'call/active')).calls.some((call: Json) => String(call.call_id) === id));
  assert.deepEqual(await rpc(callee, 'call/peer/events', { call_id: raw(id), after_seq: 0 }), journal);
  assert.equal((await rpc(owner, 'call/join', ownerJoin)).call.call_id, joined.call.call_id);
  checks.push('actual server process restart preserves device claims, active occupancy, peer journal and authorized join replay; direct defaults contain no TURN credentials');
  const end = mutation(id);
  assert.deepEqual(await rpc(callee, 'call/end', end), await rpc(callee, 'call/end', end));
  const summary = await eventually(async () => { const rows = await summaries(owner, id); assert.ok(rows.length <= 1); return rows.length === 1 ? rows[0] : undefined; });
  phase = 'terminal-server-restart';
  await stopOwnedServer(); await startOwnedServer();
  assert.equal((await rpc(owner, 'call/get', { call_id: raw(id) })).call.state, 'ended');
  assert.deepEqual((await rpc(owner, 'call/active')).calls, []);
  assert.equal((await summaries(owner, id))[0]!.message_id, summary.message_id);
  await assert.rejects(rpc(owner, 'call/peer/signal', offer), error => error instanceof RpcError);
  checks.push('terminal tombstone, released occupancy and exactly-once canonical history survive actual restart; stale peer replay denied');
  phase = 'ringing-deadline-across-downtime';
  const ringing = await invite(), timeoutId = String(ringing.call.call_id); ownedCalls.push(timeoutId);
  await stopOwnedServer();
  await sleep(Math.max(0, Number(ringing.call.expires_at_ms) - Date.now() + 250));
  await startOwnedServer();
  const timedOut = await rpc(owner, 'call/get', { call_id: raw(timeoutId) });
  assert.equal(timedOut.call.state, 'ended'); assert.equal(timedOut.call.end_reason, 'timeout');
  await eventually(async () => { const rows = await summaries(owner, timeoutId); assert.ok(rows.length <= 1); return rows.length === 1 ? true : undefined; });
  for (const e of clients) assert.deepEqual((await rpc(e, 'call/active')).calls, []);
  assert.equal(violations.length, 0);
  checks.push('absolute ringing deadline expires during server downtime; restart does not resurrect invitation; durable terminal history delivered once');
  if (process.argv.includes('--include-active-group-expiry')) {
    phase = 'active-group-invitation-deadline-after-restart';
    assert.equal(capabilities.livekit_enabled, true, 'real group authority requires configured SFU credentials');
    const third = await login('member');
    const groupInvite = await rpc(owner, 'call/invite', { command_id: randomUUID(),
      channel_id: raw(group.channelId), invitee_ids: [raw(callee.uid), raw(third.uid)],
      media_kind: 'video', supports_peer: true });
    const groupId = String(groupInvite.call.call_id); ownedCalls.push(groupId);
    const joins = [mutation(groupId), mutation(groupId)];
    for (const [index, endpoint] of [owner, callee].entries()) {
      const joinedGroup = await rpc(endpoint, 'call/join', joins[index]!);
      assert.equal(joinedGroup.call.transport, 'livekit');
      assert.ok(joinedGroup.token.length > 0); assert.equal(joinedGroup.peer, null);
      await rpc(endpoint, 'call/heartbeat', mutation(groupId));
    }
    assert.equal((await rpc(third, 'call/get', { call_id: raw(groupId) })).call.state, 'active');
    await stopOwnedServer();
    await startOwnedServer();
    const beforeExpiry = (await rpc(owner, 'call/get', { call_id: raw(groupId) })).call;
    assert.equal(beforeExpiry.state, 'active');
    assert.equal(beforeExpiry.expires_at_ms, groupInvite.call.expires_at_ms, 'restart must not extend invitation deadline');
    assert.equal(beforeExpiry.participants.find((p: Json) => String(p.user_id) === third.uid).state, 'invited');
    while (Date.now() <= Number(groupInvite.call.expires_at_ms) + 250) {
      for (const endpoint of [owner, callee]) await rpc(endpoint, 'call/heartbeat', mutation(groupId));
      await sleep(Math.min(1000, Math.max(1, Number(groupInvite.call.expires_at_ms) + 251 - Date.now())));
    }
    const snapshot = (await rpc(owner, 'call/get', { call_id: raw(groupId) })).call;
    const states = () => new Map(snapshot.participants.map((p: Json) => [String(p.user_id), p.state]));
    assert.equal(snapshot.state, 'active');
    assert.equal(states().get(owner.uid), 'joined'); assert.equal(states().get(callee.uid), 'joined');
    assert.equal(states().get(third.uid), 'left');
    const late = mutation(groupId);
    await assert.rejects(rpc(third, 'call/join', late), error => error instanceof RpcError);
    await assert.rejects(rpc(third, 'call/join', late), error => error instanceof RpcError);
    await assert.rejects(rpc(third, 'call/heartbeat', mutation(groupId)), error => error instanceof RpcError);
    assert.deepEqual((await rpc(third, 'call/active')).calls, []);
    await eventually(async () => third.states.some(event => String(event.call?.call_id) === groupId
      && event.call.state === 'active' && event.call.participants.some((p: Json) => String(p.user_id) === third.uid && p.state === 'left')) ? true : undefined);
    for (const [index, endpoint] of [owner, callee].entries()) {
      await rpc(endpoint, 'call/heartbeat', mutation(groupId));
      assert.ok((await rpc(endpoint, 'call/join', joins[index]!)).token.length > 0);
      const renewed = await rpc(endpoint, 'call/join', mutation(groupId));
      assert.equal(renewed.call.state, 'active');
      const claims = JSON.parse(Buffer.from(renewed.token.split('.')[1], 'base64url').toString());
      assert.equal(claims.video.room, `pc-${group.channelId}-${groupId}`);
      assert.equal(claims.video.roomJoin, true); assert.equal(claims.video.canPublish, true);
      assert.ok((await rpc(endpoint, 'call/active')).calls.some((call: Json) => String(call.call_id) === groupId));
    }
    checks.push('actual restart preserves original active-group invitation deadline; only unanswered UID expires, directed LEFT notification, late join/replay denied, joined heartbeats and scoped media credentials preserved');
    phase = 'active-group-left-tombstone-restart';
    await stopOwnedServer(); await startOwnedServer();
    const recovered = (await rpc(owner, 'call/get', { call_id: raw(groupId) })).call;
    assert.equal(recovered.state, 'active');
    assert.equal(recovered.participants.find((p: Json) => String(p.user_id) === third.uid).state, 'left');
    await assert.rejects(rpc(third, 'call/join', mutation(groupId)), error => error instanceof RpcError);
    assert.deepEqual((await rpc(third, 'call/active')).calls, []);
    for (const endpoint of [owner, callee]) await rpc(endpoint, 'call/heartbeat', mutation(groupId));
    await rpc(owner, 'call/end', mutation(groupId));
    checks.push('second actual restart preserves expired group invitation tombstone without resurrecting occupancy or terminating joined group');
  }
  assert.equal(violations.length, 0);
  success = true;
} finally {
  if (listener() === undefined) await startOwnedServer();
  for (const id of ownedCalls) {
    try { const current = await rpc(clients[0]!, 'call/get', { call_id: raw(id) });
      if (current.call.state !== 'ended') await rpc(clients[0]!, current.call.state === 'ringing' ? 'call/cancel' : 'call/end', mutation(id));
    } catch { if (success) success = false; }
  }
  await Promise.all(clients.map(e => e.client.disconnect().catch(() => undefined)));
  writeFileSync(`${root}/call-restart-report.json`, JSON.stringify({ success, phase, restartCount, checks, violations,
    binarySha256: authorization.binarySha256, callIds: ownedCalls, nativeMediaClaimed: false }, null, 2), { mode: 0o600 });
  console.log(`${success ? 'CALL_RESTART_PASS' : 'CALL_RESTART_FAIL'}: ${checks.length} checks; ${restartCount} actual process restarts; report=${root}/call-restart-report.json`);
  if (!success) process.exitCode = 1;
}
