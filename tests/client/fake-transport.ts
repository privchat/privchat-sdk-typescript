import {
  Packet,
  PacketType,
  type ConnectOptions,
  type EnqueuedInfo,
  type TransportConnector,
  type TransportObserver,
  type TransportSession,
} from '@msgtrans/client';

/** One scripted in-memory connection (Connector/Session SPI). */
export class FakeSession implements TransportSession {
  readonly sent: Packet[] = [];
  private readonly observers: TransportObserver[] = [];
  private open = true;

  constructor(private readonly owner: FakeTransport) {}

  isOpen(): boolean {
    return this.open;
  }

  async enqueue(packet: Packet): Promise<EnqueuedInfo> {
    if (!this.open) throw new Error('session is closed');
    this.sent.push(packet);
    if (this.owner.onSendHook !== null) await this.owner.onSendHook(packet);

    if (packet.packetType === PacketType.Request && this.owner.responder) {
      const responsePayload = this.owner.responder(packet);
      if (responsePayload !== undefined) {
        const responseBizType =
          this.owner.responseBizTypeFor?.(packet.bizType) ?? packet.bizType;
        // Fire asynchronously so the request-side promise has registered.
        queueMicrotask(() => {
          this.fireMessage(
            new Packet({
              packetType: PacketType.Response,
              messageId: packet.messageId,
              bizType: responseBizType,
              payload: responsePayload,
            }),
          );
        });
      }
    }
    return { messageId: packet.messageId };
  }

  subscribe(observer: TransportObserver): () => void {
    this.observers.push(observer);
    return () => {
      const i = this.observers.indexOf(observer);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  close(reason?: unknown): Promise<void> {
    if (this.open) {
      this.open = false;
      // Mirror the real WebSocket session: the close report lands on the
      // next microtask, which is what runs the SDK's close-driven state
      // machine (heartbeat failure → close → auto-reconnect).
      queueMicrotask(() => {
        for (const o of [...this.observers]) o.onClose?.(reason);
      });
    }
    return Promise.resolve();
  }

  fireMessage(packet: Packet): void {
    if (!this.open) return;
    for (const o of [...this.observers]) o.onMessage?.(packet);
  }
  fireClose(ev?: unknown): void {
    if (!this.open) return;
    this.open = false;
    for (const o of [...this.observers]) o.onClose?.(ev);
  }
  fireError(e: unknown): void {
    for (const o of [...this.observers]) o.onError?.(e);
  }
}

/**
 * In-memory connector for unit tests, keeping the old helper surface:
 * `sent` aggregates across sessions; `fireMessage`/`fireClose`/`fireError`
 * act on the CURRENT session; the per-bizType `responder` synthesises
 * Response packets.
 */
export class FakeTransport implements TransportConnector {
  readonly sessions: FakeSession[] = [];

  /** Per-bizType auto-responder. Return a Uint8Array to send back, or
   *  `undefined` to silently drop the request. */
  responder: ((packet: Packet) => Uint8Array | undefined) | null = null;
  /** Awaited before the response is produced. */
  onSendHook: ((packet: Packet) => Promise<void> | void) | null = null;
  /** Override to use a different response bizType than the request's. */
  responseBizTypeFor: ((requestBizType: number) => number) | null = null;

  get sent(): Packet[] {
    return this.sessions.flatMap((s) => s.sent);
  }

  get current(): FakeSession | null {
    const last = this.sessions[this.sessions.length - 1];
    return last && last.isOpen() ? last : null;
  }

  async connect(_options: ConnectOptions): Promise<TransportSession> {
    const session = new FakeSession(this);
    this.sessions.push(session);
    return session;
  }

  isConnected(): boolean {
    return this.current !== null;
  }

  fireMessage(packet: Packet): void {
    this.sessions[this.sessions.length - 1]?.fireMessage(packet);
  }
  fireClose(ev?: unknown): void {
    this.sessions[this.sessions.length - 1]?.fireClose(ev);
  }
  fireError(e: unknown): void {
    this.sessions[this.sessions.length - 1]?.fireError(e);
  }
}
