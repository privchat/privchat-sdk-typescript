// Phase-5-finalize: client.dispose() lifecycle.
//
// Validates the post-Phase-5 SDK terminal-lifecycle API. dispose() is
// the platform-neutral hook host runtimes (browser app, Tauri, KMP
// bridge) call when their tab/window/process is going away.

import { afterEach, describe, expect, it } from 'vitest';
import {
  PrivchatClient,
  encodeAuthorizationResponse,
} from '../../src/index.js';
import { FakeTransport } from './fake-transport.js';

let client: PrivchatClient | null = null;
let dbCounter = 0;
afterEach(async () => {
  if (client) {
    try {
      await client.dispose();
    } catch {
      /* */
    }
    client = null;
  }
});

describe('client.dispose()', () => {
  it('is idempotent — second call is a no-op', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({ transport: t });
    await client.dispose();
    await client.dispose(); // must not throw
    await client.dispose();
  });

  it('disposes a never-connected client cleanly', async () => {
    const t = new FakeTransport();
    client = new PrivchatClient({ transport: t });
    expect(client.connectionState()).toBe('disconnected');
    await client.dispose();
    expect(client.connectionState()).toBe('disconnected');
  });

  it('closes the transport on a connected client + emits state events', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    client = new PrivchatClient({ transport: t });

    const states: string[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'connection_state_changed') {
        states.push(env.event.state);
      }
    });

    await client.connect();
    await client.authenticate('1', 't', 'd');
    expect(client.connectionState()).toBe('authenticated');

    await client.dispose();
    expect(client.connectionState()).toBe('disconnected');

    // Must have transitioned through 'closing' on the way out (mirrors
    // disconnect()'s state machine; host UIs key off this).
    expect(states).toContain('closing');
    expect(states[states.length - 1]).toBe('disconnected');
  });

  it('emits the final connection_state_changed with reason="disposed"', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    client = new PrivchatClient({ transport: t });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    let lastReason: string | undefined;
    client.observeEvents((env) => {
      if (
        env.event.type === 'connection_state_changed' &&
        env.event.state === 'disconnected'
      ) {
        lastReason = env.event.reason;
      }
    });

    await client.dispose();
    expect(lastReason).toBe('disposed');
  });

  it('after dispose() does NOT re-emit if the user had already disconnect()ed', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    client = new PrivchatClient({ transport: t });
    await client.connect();
    await client.authenticate('1', 't', 'd');

    const states: string[] = [];
    client.observeEvents((env) => {
      if (env.event.type === 'connection_state_changed') {
        states.push(env.event.state);
      }
    });

    await client.disconnect();
    const disconnectStateCount = states.filter((s) => s === 'disconnected').length;

    await client.dispose();
    // dispose() must NOT add a second 'disconnected' (state was already
    // disconnected; the close path was already driven by disconnect()).
    expect(states.filter((s) => s === 'disconnected').length).toBe(
      disconnectStateCount,
    );
  });

  it('clears outbox observers (cache-enabled)', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName: `dispose-obs-${++dbCounter}` },
    });

    // Resolve when the initial snapshot fires — avoids a fixed-timeout
    // race when the IndexedDB has migrations to run on first open.
    let snapshotCount = 0;
    let firstSnapshot: () => void = () => undefined;
    const snapshotReady = new Promise<void>((r) => {
      firstSnapshot = r;
    });
    client.observeOutbox(() => {
      snapshotCount += 1;
      firstSnapshot();
    });
    await snapshotReady;
    expect(snapshotCount).toBeGreaterThanOrEqual(1);

    await client.dispose();
    // Persisted state mutations after dispose would normally retrigger
    // observers. With observers cleared they don't.
    const before = snapshotCount;
    await new Promise((r) => setTimeout(r, 30));
    expect(snapshotCount).toBe(before);
  });

  it('closes the Dexie handle (cache-enabled)', async () => {
    const t = new FakeTransport();
    t.responder = () => encodeAuthorizationResponse({ success: true });
    const dbName = `dispose-dexie-${++dbCounter}`;
    client = new PrivchatClient({
      transport: t,
      cache: { enabled: true, dbName },
    });
    // Force IDB to be open (Dexie opens lazily on first access).
    await client.outboxEntries();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (client as any).cacheDb;
    expect(db.isOpen()).toBe(true);

    await client.dispose();
    expect(db.isOpen()).toBe(false);
  });

  it('persisted IndexedDB data survives dispose — fresh client sees it', async () => {
    // Skip connect/authenticate so sendTextMessage takes the offline →
    // queued path. The persistence claim is "IDB rows survive a dispose
    // + reconstruct cycle", which is what we want to check.
    const t1 = new FakeTransport();
    const dbName = `dispose-persist-${++dbCounter}`;
    const c1 = new PrivchatClient({
      transport: t1,
      cache: { enabled: true, dbName },
    });
    const queued = await c1.sendTextMessage({
      channel_id: '100',
      channel_type: 1,
      from_uid: '1',
      content: 'survives-dispose',
      local_message_id: '9007199254740991',
    });
    expect(queued.status).toBe('queued');
    expect(await c1.outboxEntries()).toHaveLength(1);

    await c1.dispose();

    // Brand-new client, same dbName → must see the same outbox row.
    const t2 = new FakeTransport();
    client = new PrivchatClient({
      transport: t2,
      cache: { enabled: true, dbName },
    });
    const rows = await client.outboxEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outbox_id).toBe('9007199254740991');
  });
});
