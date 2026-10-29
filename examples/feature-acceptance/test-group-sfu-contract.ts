import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeGroupResult, validateNativeXCTestSummary } from './group-sfu-contract.js';

const valid = { room: 'pc-7-638108239673901056', callId: '638108239673901056',
  peerIdentities: ['actual-peer-2', 'actual-peer-3'], decodedFrames: [3, 5],
  rpcIssuedCredentials: true, syntheticVideoSource: true, physicalCamera: false };
const validate = (value: unknown) => validateNativeGroupResult(value, valid.room, valid.callId, valid.peerIdentities);
test('accepts two actual streams bound to the current RPC call and run', () => {
  assert.deepEqual(validate(valid), valid);
  assert.equal((validate({ ...valid, token: 'must-not-escape' }) as any).token, undefined);
});
for (const [name, patch] of Object.entries({
  'stale room': { room: 'old' }, 'stale call': { callId: '1' }, 'manual credentials': { rpcIssuedCredentials: false },
  'fixture identities': { peerIdentities: ['ios-peer', 'ios-peer-2'] },
  'duplicate peer': { peerIdentities: ['actual-peer-2', 'actual-peer-2'] },
  'no decoded frames': { decodedFrames: [0, 5] }, 'one stream': { decodedFrames: [5] },
  'false hardware claim': { physicalCamera: true }, 'unknown frame source': { syntheticVideoSource: false },
})) test(`rejects ${name}`, () => assert.throws(() => validate({ ...valid, ...patch })));

const summary = { result: 'Passed', totalTestCount: 1, passedTests: 1, failedTests: 0,
  skippedTests: 0, expectedFailures: 0, startTime: 100, finishTime: 101 };
test('requires a fresh, completed, passing focused XCTest in addition to frame proof', () => {
  assert.equal(validateNativeXCTestSummary(summary, 99000).result, 'Passed');
});
for (const [name, patch] of Object.entries({ stale: { startTime: 90 }, failed: { failedTests: 1 },
  skipped: { skippedTests: 1 }, incomplete: { result: 'In Progress' },
  empty: { totalTestCount: 0 }, mixed: { totalTestCount: 2 }, expectedFailure: { expectedFailures: 1 },
})) test(`rejects ${name} XCTest completion`, () => assert.throws(() => validateNativeXCTestSummary({ ...summary, ...patch }, 99000)));
