// Guard-only checks. No login, RPC, native execution or media pass is claimed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let passed = 0;
function rejects(script, overrides, expected) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', `examples/feature-acceptance/${script}`, ...(script === 'native-media-carrier.ts' ? ['--dry-run'] : [])], {
    cwd: sdk, env: { ...process.env, ...overrides }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0, 'unsafe fixture must fail before any RPC');
  assert.match(child.stderr, expected);
  assert.doesNotMatch(child.stdout, /CALL_RUNTIME_PASS|CARRIER_PASS|CALL_NATIVE_EXCHANGE_DIR/);
  passed++;
}
for (const script of ['call-runtime.ts', 'native-media-carrier.ts']) {
  rejects(script, { PRIVCHAT_FEATURE_ROOT: '' }, /AssertionError/);
  rejects(script, { PRIVCHAT_FEATURE_ROOT: '/tmp' }, /AssertionError/);
}
if (process.env.PRIVCHAT_FEATURE_ROOT) {
  rejects('native-media-carrier.ts', { PRIVCHAT_NATIVE_EXCHANGE_PARENT: '/tmp' }, /AssertionError/);
}
console.log(`CALL_FIXTURE_GUARDS_PASS: ${passed} rejected unsafe configurations; no media claim`);
