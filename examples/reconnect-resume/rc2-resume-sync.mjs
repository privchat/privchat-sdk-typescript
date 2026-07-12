// RC-2 regression harness: unexpected disconnect → reconnect → resume sync.
//
// Deterministic (no reliance on cross-phase state / sleeps for correctness),
// standalone Node script against a live privchat-server. Kept per GPT's RC-2
// review as the long-term SDK regression for the reconnect / resume-sync /
// outbox / subscription-replay surface.
//
// Run (from privchat-sdk-typescript/, needs the SDK built into dist/):
//   npm run build
//   node examples/reconnect-resume/rc2-resume-sync.mjs [runs]
//   PRIVCHAT_HOST=127.0.0.1 PRIVCHAT_WS_PORT=9080 node examples/reconnect-resume/rc2-resume-sync.mjs 5
//
// Hard assertions (per run): exactly one reconnect cycle, exactly one
// resume-sync round (sync/get_difference), peer's offline messages backfilled,
// the client's own offline-queued message auto-flushed + server_message_id
// backfilled + outbox drained, no duplicate ids, timestamp order preserved.
// Exit code 0 iff every run is green.

import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { PrivchatClient } from '../../dist/index.js';

const HOST = process.env.PRIVCHAT_HOST ?? '127.0.0.1';
const PORT = process.env.PRIVCHAT_WS_PORT ?? '9080';
const URL = `ws://${HOST}:${PORT}/`;
const DT = 1; // DIRECT_SYNC_CHANNEL_TYPE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reg(username, opts = {}) {
  const device_id = randomUUID();
  const c = new PrivchatClient({ url: URL, defaultTimeoutMs: 30_000, ...opts });
  await c.connect();
  const r = await c.rpcCallTyped('account/user/register', {
    username, password: 'password123', device_id,
    device_info: { device_id, device_type: 'web', app_id: 'rc2', device_name: 'rc2', app_version: '0.1.0' },
  });
  await c.authenticate(String(r.user_id), r.token, r.device_id);
  return { c, uid: String(r.user_id) };
}

const waitFor = async (pred, ms) => {
  const t = Date.now() + ms;
  while (Date.now() < t) { if (await pred()) return true; await sleep(50); }
  return false;
};

async function runOnce(i) {
  const sfx = `${Date.now() % 1e6}${i}`;
  const A = await reg('rc2a_' + sfx, {
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 200, multiplier: 1.5 },
    cache: { enabled: true, dbName: 'rc2a-' + sfx },
  });
  const B = await reg('rc2b_' + sfx);

  const states = [];
  let reconnectAttempts = 0;
  const off = A.c.observeEvents((ev) => {
    if (ev?.event?.type === 'connection_state_changed') {
      const st = ev.event.state;
      states.push(st);
      if (st === 'connecting' || st === 'reconnecting') reconnectAttempts++;
    }
  });

  await A.c.friendApply(Number(B.uid), 'hi', 'friend', B.uid);
  await B.c.friendAccept(Number(A.uid), 'ok');
  const dm = await A.c.channelDirectGetOrCreate(Number(B.uid), 'rc2', 'rc2');
  const cid = String(dm.channel_id);
  await B.c.channelDirectGetOrCreate(Number(A.uid), 'rc2', 'rc2');
  await A.c.subscribeChannel(cid, DT);
  await B.c.subscribeChannel(cid, DT);
  await A.c.sendTextMessage({ channel_id: cid, channel_type: DT, from_uid: A.uid, content: 'seed@' + sfx });
  await sleep(300);
  await A.c.openConversation(cid, DT);

  // Count resume-sync rounds by wrapping the difference RPC on this instance.
  let syncDiffCalls = 0;
  const orig = A.c.rpcCallTyped.bind(A.c);
  A.c.rpcCallTyped = (route, ...a) => { if (route === 'sync/get_difference') syncDiffCalls++; return orig(route, ...a); };
  const diffBefore = syncDiffCalls;

  await A.c.simulateUnexpectedDisconnect();
  const q = await A.c.sendTextMessage({ channel_id: cid, channel_type: DT, from_uid: A.uid, content: 'offline@' + sfx });
  const queuedOk = q.status === 'queued';
  const offLid = q.local_message_id;

  const bIds = [];
  for (let k = 0; k < 2; k++) {
    const r = await B.c.sendTextMessage({ channel_id: cid, channel_type: DT, from_uid: B.uid, content: `gap${k}@${sfx}` });
    if (r.status === 'sent') bIds.push(r.response.server_message_id);
    await sleep(30);
  }

  const converged = await waitFor(async () => {
    if (A.c.connectionState() !== 'authenticated') return false;
    const ids = new Set(A.c.getCachedMessages(cid, DT).map((m) => m.server_message_id));
    if (!bIds.every((id) => ids.has(id))) return false;
    const pend = (await A.c.outboxEntries()).filter((e) => ['pending', 'sending', 'queued'].includes(e.status)).length;
    return pend === 0;
  }, 12_000);

  const msgs = A.c.getCachedMessages(cid, DT);
  const ids = msgs.map((m) => m.server_message_id).filter(Boolean);
  const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  const seqs = msgs.map((m) => Number(m.timestamp ?? 0));
  const ordered = seqs.every((v, idx) => idx === 0 || v >= seqs[idx - 1]);
  const offMsg = msgs.find((m) => m.local_message_id === offLid);
  const offbox = await A.c.outboxEntries();

  off();
  await A.c.disconnect();
  await B.c.disconnect();
  await A.c.dispose?.();

  return {
    run: i, converged, queuedOk, reconnectAttempts, syncRounds: syncDiffCalls - diffBefore,
    backfilled: bIds.filter((id) => new Set(ids).has(id)).length,
    offlineSent: !!offMsg?.server_message_id, dupes: dupes.length, ordered, outboxLeft: offbox.length,
    statesSeq: states.join('>'),
  };
}

const N = Number(process.argv[2] || 3);
const results = [];
for (let i = 1; i <= N; i++) {
  try { results.push(await runOnce(i)); }
  catch (e) { results.push({ run: i, error: e?.message?.slice(0, 160) }); }
}
let green = 0;
for (const r of results) {
  const ok = !r.error && r.converged && r.reconnectAttempts === 1 && r.syncRounds <= 1 &&
    r.backfilled === 2 && r.offlineSent && r.dupes === 0 && r.ordered && r.outboxLeft === 0;
  if (ok) green++;
  console.log((ok ? '[PASS] ' : '[FAIL] ') + JSON.stringify(r));
}
console.log(`\nRC-2 resume-sync: ${green}/${results.length} green`);
process.exit(green === results.length ? 0 : 1);
