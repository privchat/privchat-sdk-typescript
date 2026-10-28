import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrivchatClient } from '../../src/index.js';
import { assertPrivateFixtureRoot } from './fixture.js';

const root = process.env.PRIVCHAT_FEATURE_ROOT ?? '';
assertPrivateFixtureRoot(root);
const fixture = JSON.parse(readFileSync(`${root}/public.json`, 'utf8'));
const group = JSON.parse(readFileSync(`${root}/group.json`, 'utf8'));
const accounts = JSON.parse(readFileSync(`${root}/accounts.json`, 'utf8'));
const results: string[] = [];
for (const role of ['owner', 'admin', 'member']) {
  const client = new PrivchatClient({ url: `ws://127.0.0.1:${fixture.wsPort}/gate`, defaultTimeoutMs: 15000 });
  try {
    await client.connect();
    const device = randomUUID();
    const auth = await client.rpcCallTyped<any, any>('account/auth/login', {
      username: accounts[role].username, password: accounts[role].password,
      device_id: device, device_info: { device_id: device, device_type: 'web',
        app_id: `feature-persistence-${role}`, device_name: 'Disposable acceptance' },
    });
    await client.authenticate(String(auth.user_id), auth.token, auth.device_id);
    const info = await client.groupInfo(Number(group.groupId));
    assert.equal(info.group_info?.description, 'Administrator introduction, persisted by real RPC');
    const pins = await client.messagePinList(Number(group.groupId));
    assert.deepEqual(new Set(pins.items.map(p => String(p.message_id))), new Set(group.messageIds));
    const history = await client.messageHistory(group.groupId, 50);
    assert.ok(JSON.stringify(history).includes('Owner pin acceptance message'));
    if (role === 'member') await assert.rejects(client.groupUpdate(group.groupId, { description: 'Forbidden after restart' }));
    results.push(`${role}: fresh login, persisted introduction, pins and server history`);
  } finally { await client.disconnect(); }
}
writeFileSync(`${root}/persistence-report.json`, JSON.stringify({ success: true, results,
  serverRestart: JSON.parse(readFileSync(`${root}/restart.json`, 'utf8')) }, null, 2));
console.log('FEATURE_RESTART_PASS: new server process, three fresh SDK logins, persistent introduction/pins/history and member authorization');
