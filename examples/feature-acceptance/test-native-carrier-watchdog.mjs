// Run: node --import tsx --test examples/feature-acceptance/test-native-carrier-watchdog.mjs
// With PRIVCHAT_FEATURE_ROOT, also test real RPC cleanup after deliberately failed harness runs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bounded, CarrierFailure, ExchangeLocator, findMovedExchange } from './native-carrier-watchdog.ts';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = resolve(sdk, '../.artifacts/feature-closure/2026-10-25/calls');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const out = mkdtempSync(join(artifacts, 'watchdog-tests.'));
const code = expected => error => error instanceof CarrierFailure && error.code === expected;

await test('unresolved SDK-like operations have a hard per-operation deadline', async () => {
  await assert.rejects(bounded('rpc', () => new Promise(() => {}), 20), code('rpc_TIMEOUT'));
  await assert.rejects(bounded('disconnect', () => new Promise(() => {}), 20), code('disconnect_TIMEOUT'));
});
await test('overall abort interrupts an in-flight operation without awaiting SDK settlement', async () => {
  const abort = new AbortController();
  const work = bounded('rpc', () => new Promise(() => {}), 1000, abort.signal);
  abort.abort();
  await assert.rejects(work, code('RUN_ABORTED'));
});
const ready = Buffer.from('{"callId":"guard-only-not-a-media-receipt"}');
const hash = createHash('sha256').update(ready).digest('hex');
function makeExchange(path, pid = process.pid, bytes = ready) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'broker.lock'), String(pid), { mode: 0o600 });
  writeFileSync(join(path, 'peer-ready.json'), bytes, { mode: 0o600 });
}
await test('missing or replaced exchange fails, rather than silently polling a deleted container', () => {
  const path = join(out, 'privchat-native-peer-guard-12345678');
  makeExchange(path);
  const locator = new ExchangeLocator(path, false);
  locator.bindReady();
  renameSync(path, path + '.moved');
  assert.throws(() => locator.ensure(), code('EXCHANGE_MISSING_OR_REPLACED'));
});
await test('relocation requires a unique private PID-lock and exact ready-content match', () => {
  // Ordinary project-owned directories, not actual simulator containers.
  const apps = join(out, 'mock-applications'), name = 'privchat-native-peer-guard-87654321';
  const first = join(apps, 'AAAA-BBBB', 'Documents', name);
  makeExchange(first);
  makeExchange(join(apps, 'CCCC-DDDD', 'Documents', name), process.pid + 1);
  makeExchange(join(apps, 'EEEE-FFFF', 'Documents', name), process.pid, Buffer.from('{}'));
  assert.equal(findMovedExchange(apps, name, process.pid, hash), first);
  makeExchange(join(apps, '1111-2222', 'Documents', name));
  assert.throws(() => findMovedExchange(apps, name, process.pid, hash), code('EXCHANGE_RELOCATION_NOT_UNIQUE'));
});

const fixture = process.env.PRIVCHAT_FEATURE_ROOT;
async function failedRun(name, action, expected, runtime = 15000) {
  const env = { ...process.env, PRIVCHAT_NATIVE_EXCHANGE_PARENT: fixture, PRIVCHAT_NATIVE_FOLLOW_CONTAINER_MOVE: '0', PRIVCHAT_NATIVE_TIMEOUT_MS: String(runtime) };
  delete env.PRIVCHAT_NATIVE_EXCHANGE_NAME;
  const child = spawn(process.execPath, ['--import', 'tsx', 'examples/feature-acceptance/native-media-carrier.ts', '--serve'], { cwd: sdk, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', acted = false;
  const hardStop = setTimeout(() => child.kill('SIGTERM'), 45000);
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    stdout += data;
    const control = stdout.match(/^BROKER_CONTROL_DIR=(.+)$/m)?.[1];
    const directory = stdout.match(/^CALL_NATIVE_EXCHANGE_DIR=(.+)$/m)?.[1];
    if (!acted && control && directory) { acted = true; action(directory, control, child); }
  });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  clearTimeout(hardStop);
  assert.equal(stderr, '');
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(acted, true);
  const control = stdout.match(/^BROKER_CONTROL_DIR=(.+)$/m)[1];
  const report = JSON.parse(readFileSync(join(control, 'broker-report.json')));
  assert.equal(report.success, false);
  assert.equal(report.nativeFramesClaimed, false);
  assert.equal(report.cleanup, 'ended-via-rpc');
  assert.equal(report.failure.reason, expected);
  assert.ok(report.durationMs < 20000);
  console.log(`${name}: actual server call=${report.callId}; cleanup=ended-via-rpc; report=${control}/broker-report.json`);
  return report;
}
await test('real server: native failure completion is reported and its owned call ends by RPC', { skip: !fixture, timeout: 60000 }, async () => {
  await failedRun('native-failure', directory => writeFileSync(join(directory, 'native-done.json'), '{"ok":false}', { mode: 0o600, flag: 'wx' }), 'NATIVE_REPORTED_FAILURE');
});
await test('real server: vanished exchange still produces the control report and RPC cleanup', { skip: !fixture, timeout: 60000 }, async () => {
  const report = await failedRun('directory-loss', directory => renameSync(directory, directory + '.moved'), 'EXCHANGE_MISSING_OR_REPLACED');
  assert.equal(report.exchangeReportWritten, false);
});
await test('real server: deadline interrupts native wait and is never a successful receipt', { skip: !fixture, timeout: 60000 }, async () => {
  await failedRun('deadline', () => {}, 'RUN_ABORTED', 6000);
});
await test('real server: SIGTERM triggers bounded cleanup, not lost evidence', { skip: !fixture, timeout: 60000 }, async () => {
  await failedRun('signal-stop', (_directory, _control, child) => child.kill('SIGTERM'), 'RUN_ABORTED');
});
