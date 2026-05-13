// Idle-heartbeat loop: send PingRequest while authenticated AND idle;
// keep the WS path warm and surface zombie connections fast.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeAuthorizationResponse,
  encodePongResponse,
  PrivchatClient,
} from '../../src/index.js';
import { MessageType } from '../../src/message-type.js';
import { FakeTransport } from './fake-transport.js';
import { Packet, PacketType } from '@msgtrans/client';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** Build a responder that handles Authorization + Ping, and counts pings. */
function responderWithPingCounter(): {
  responder: (p: Packet) => Uint8Array | undefined;
  responseBizTypeFor: (b: number) => number;
  pingCount: () => number;
  setPingResponder: (
    fn: (p: Packet) => Uint8Array | undefined | 'drop',
  ) => void;
} {
  let pings = 0;
  let pingFn: (p: Packet) => Uint8Array | undefined | 'drop' = (p) =>
    encodePongResponse({ timestamp: Date.now() });

  return {
    pingCount: () => pings,
    setPingResponder(fn) {
      pingFn = fn;
    },
    responder: (p: Packet): Uint8Array | undefined => {
      if (p.bizType === MessageType.PingRequest) {
        pings++;
        const r = pingFn(p);
        if (r === 'drop') return undefined;
        return r;
      }
      // Default = Authorization (only other request type used in these tests).
      return encodeAuthorizationResponse({ success: true });
    },
    responseBizTypeFor: (b: number): number => {
      if (b === MessageType.PingRequest) return MessageType.PongResponse;
      return b;
    },
  };
}

describe('idle heartbeat', () => {
  it('sends a ping after intervalMs of silence while authenticated', async () => {
    const t = new FakeTransport();
    const r = responderWithPingCounter();
    t.responder = r.responder;
    t.responseBizTypeFor = r.responseBizTypeFor;

    const client = new PrivchatClient({
      transport: t,
      heartbeat: { enabled: true, intervalMs: 1_000, timeoutMs: 500 },
      // Keep reconnect noise out of the assertions in this test.
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.authenticate('900710001', 'tok', 'dev-1');
    expect(r.pingCount()).toBe(0);

    // Sit idle past the interval — exactly one ping should fire.
    await advance(1_100);
    await Promise.resolve(); // microtask: ping promise + responder
    expect(r.pingCount()).toBe(1);
    expect(client.connectionState()).toBe('authenticated');
  });

  it('does NOT ping when traffic kept the connection busy', async () => {
    const t = new FakeTransport();
    const r = responderWithPingCounter();
    t.responder = r.responder;
    t.responseBizTypeFor = r.responseBizTypeFor;

    const client = new PrivchatClient({
      transport: t,
      heartbeat: { enabled: true, intervalMs: 1_000, timeoutMs: 500 },
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    // Fake an inbound push every 600ms — well inside the 1000ms idle
    // window. The heartbeat tick should keep deferring without ever
    // sending a ping.
    for (let i = 0; i < 5; i++) {
      await advance(600);
      t.fireMessage(
        new Packet({
          packetType: PacketType.OneWay,
          messageId: 1_000 + i,
          bizType: MessageType.PushMessageRequest,
          payload: new Uint8Array(0),
        }),
      );
    }
    expect(r.pingCount()).toBe(0);
  });

  it('respects heartbeat.enabled = false', async () => {
    const t = new FakeTransport();
    const r = responderWithPingCounter();
    t.responder = r.responder;
    t.responseBizTypeFor = r.responseBizTypeFor;

    const client = new PrivchatClient({
      transport: t,
      heartbeat: { enabled: false, intervalMs: 1_000 },
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    await advance(10_000);
    expect(r.pingCount()).toBe(0);
  });

  it('closes transport when ping times out, triggering auto-reconnect', async () => {
    const t = new FakeTransport();
    let authCount = 0;
    let dropNextPing = true;
    t.responseBizTypeFor = (b: number) =>
      b === MessageType.PingRequest ? MessageType.PongResponse : b;
    t.responder = (p: Packet): Uint8Array | undefined => {
      if (p.bizType === MessageType.PingRequest) {
        if (dropNextPing) {
          // Silently drop → the SDK's request promise times out.
          dropNextPing = false;
          return undefined;
        }
        return encodePongResponse({ timestamp: Date.now() });
      }
      authCount++;
      return encodeAuthorizationResponse({ success: true });
    };

    const client = new PrivchatClient({
      transport: t,
      heartbeat: { enabled: true, intervalMs: 1_000, timeoutMs: 500 },
      reconnect: {
        enabled: true,
        initialDelayMs: 100,
        maxDelayMs: 100,
        multiplier: 1,
      },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');
    expect(authCount).toBe(1);

    // Idle past intervalMs → ping fires → no responder → SDK request
    // times out after `timeoutMs` → transport.close() → reconnect path.
    // Advance enough to cross: intervalMs (1000) + ping timeoutMs (500)
    // + reconnect backoff (100) + some slack. Microtask drain lets the
    // reconnect+reauth promise chain resolve.
    await advance(2_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // End state: heartbeat ping timed out → close → reconnect (100ms)
    // → connect → re-authenticate → back to 'authenticated'.
    expect(authCount).toBe(2);
    expect(client.connectionState()).toBe('authenticated');
  });

  it('stops pinging after disconnect()', async () => {
    const t = new FakeTransport();
    const r = responderWithPingCounter();
    t.responder = r.responder;
    t.responseBizTypeFor = r.responseBizTypeFor;

    const client = new PrivchatClient({
      transport: t,
      heartbeat: { enabled: true, intervalMs: 1_000 },
      reconnect: { enabled: false },
    });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    await client.disconnect();
    expect(client.connectionState()).toBe('disconnected');
    const before = r.pingCount();

    // Sit "idle" — no ping must fire because heartbeat is stopped.
    await advance(5_000);
    expect(r.pingCount()).toBe(before);
  });
});
