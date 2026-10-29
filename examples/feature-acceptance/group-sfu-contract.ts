import assert from 'node:assert/strict';

export interface NativeGroupResult {
  callId: string;
  room: string;
  peerIdentities: string[];
  decodedFrames: number[];
  rpcIssuedCredentials: true;
  syntheticVideoSource: true;
  physicalCamera: false;
}

export function validateNativeGroupResult(value: unknown, room: string, callId: string,
  expectedPeerIdentities: string[]): NativeGroupResult {
  const result = value as NativeGroupResult;
  assert.ok(result && typeof result === 'object');
  assert.equal(result.callId, callId);
  assert.equal(result.room, room);
  assert.equal(result.rpcIssuedCredentials, true);
  assert.equal(result.syntheticVideoSource, true);
  assert.equal(result.physicalCamera, false);
  assert.equal(new Set(expectedPeerIdentities).size, 2);
  assert.ok(Array.isArray(result.peerIdentities));
  assert.deepEqual([...result.peerIdentities].sort(), [...expectedPeerIdentities].sort());
  assert.ok(Array.isArray(result.decodedFrames) && result.decodedFrames.length === 2);
  assert.ok(result.decodedFrames.every(n => Number.isSafeInteger(n) && n >= 3));
  // Whitelist evidence; never copy arbitrary native output into a public receipt.
  return { room, callId, peerIdentities: result.peerIdentities,
    decodedFrames: result.decodedFrames, rpcIssuedCredentials: true, syntheticVideoSource: true, physicalCamera: false };
}

export function validateNativeXCTestSummary(value: unknown, startedMs: number) {
  const summary = value as Record<string, any>;
  assert.equal(summary.result, 'Passed');
  assert.equal(summary.totalTestCount, 1);
  assert.equal(summary.passedTests, 1);
  assert.equal(summary.failedTests, 0);
  assert.equal(summary.skippedTests, 0);
  assert.equal(summary.expectedFailures, 0);
  assert.ok(Number.isFinite(summary.startTime) && summary.startTime * 1000 >= startedMs);
  assert.ok(Number.isFinite(summary.finishTime) && summary.finishTime >= summary.startTime);
  return { result: 'Passed', passed: 1, failed: 0, skipped: 0,
    startTime: summary.startTime, finishTime: summary.finishTime };
}
