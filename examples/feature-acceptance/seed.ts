import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { MultiAccountManager } from '../accounts/src/account-manager.js';
import { phase02_friend_system } from '../accounts/src/phases/phase02-friend.js';

const root = process.env.PRIVCHAT_FEATURE_ROOT ?? '';
assert.match(root, /^\/tmp\/privchat-features-im\.[A-Za-z0-9]+$/);
assert.equal(statSync(root).mode & 0o077, 0, 'private disposable root required');
const fixture = JSON.parse(readFileSync(`${root}/public.json`, 'utf8'));
assert.equal(fixture.host, '127.0.0.1');
const manager = await MultiAccountManager.create({ host: fixture.host, wsPort: fixture.wsPort });
const report: Record<string, unknown> = { checks: [], noProduction: true };
const checks = report.checks as string[];
try {
  const owner = manager.client('alice'), admin = manager.client('bob'), member = manager.client('charlie');
  const accounts = { owner: manager.config('alice'), admin: manager.config('bob'), member: manager.config('charlie') };
  writeFileSync(`${root}/accounts.json`, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  const friends = await phase02_friend_system(manager);
  assert.equal(friends.success, true, JSON.stringify(friends.metrics.errors));
  checks.push('three real registered/authenticated users and mutual friendships');
  const created = await owner.groupCreate('Feature acceptance group', 'Initial persistent introduction');
  const groupId = created.group_id;
  await owner.groupMemberAdd(groupId, Number(manager.userId('bob')));
  await owner.groupMemberAdd(groupId, Number(manager.userId('charlie')));
  await owner.groupRoleSet(groupId, Number(manager.userId('alice')), Number(manager.userId('bob')), 'admin');
  checks.push('real group created with owner/admin/member');
  await admin.groupUpdate(String(groupId), { description: 'Administrator introduction, persisted by real RPC' });
  const information = await member.groupInfo(groupId);
  assert.equal(information.group_info?.description, 'Administrator introduction, persisted by real RPC');
  await assert.rejects(member.groupUpdate(String(groupId), { description: 'Unauthorized change' }));
  checks.push('administrator writes introduction; member reads and cannot edit');
  const sent = [];
  for (const content of ['Owner pin acceptance message', 'Administrator pin acceptance message']) {
    const result = await owner.sendTextMessage({ channel_id: String(groupId), channel_type: 2,
      from_uid: manager.userId('alice'), content });
    assert.equal(result.status, 'sent');
    if (result.status !== 'sent') throw Error('Message queued instead of acknowledged');
    assert.equal(result.response.reason_code, 0);
    sent.push(result.response.server_message_id);
  }
  await owner.messagePin(groupId, groupId, sent[0], true);
  await admin.messagePin(groupId, groupId, sent[1], true);
  await assert.rejects(member.messagePin(groupId, groupId, sent[1], false));
  await assert.rejects(admin.messagePin(groupId, groupId, sent[0], false));
  const pins = await member.messagePinList(groupId);
  assert.equal(pins.items.length, 2);
  await owner.messagePin(groupId, groupId, sent[0], true);
  const repeated = await owner.messagePinList(groupId);
  assert.deepEqual(repeated.items, pins.items);
  checks.push('two distinct pins; member forbidden; admin cannot unpin owner; retry preserves order');
  writeFileSync(`${root}/group.json`, JSON.stringify({ groupId: String(groupId), channelId: String(groupId),
    messageIds: sent, directChannelId: String(manager.cachedDirectChannel('alice', 'bob')) }, null, 2), { mode: 0o600 });
  report.groupId = String(groupId);
  report.messageIds = sent;
  report.success = true;
  writeFileSync(`${root}/seed-report.json`, JSON.stringify(report, null, 2));
  console.log('FEATURE_REAL_IM_SEED_PASS: registered users, role-protected persistent introduction, multiple pins and retry invariants');
} finally { await manager.cleanup(); }
