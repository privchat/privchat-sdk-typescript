import {
  Packet,
  PacketType,
  type SentInfo,
  type Transport,
} from '@msgtrans/client';

/**
 * In-memory Transport for unit tests. Captures every packet handed to
 * `send()` and lets the test register a per-bizType handler that produces
 * the response payload — the FakeTransport then synthesises a Response
 * packet (matching messageId) and fires it back through onMessage.
 */
export class FakeTransport implements Transport {
  readonly sent: Packet[] = [];

  /** Per-bizType auto-responder. Return a Uint8Array to send back, or
   *  `undefined` to silently drop the request. */
  responder: ((packet: Packet) => Uint8Array | undefined) | null = null;

  /** Override to use a different response bizType than the request's. */
  responseBizTypeFor: ((requestBizType: number) => number) | null = null;

  private _connected = false;
  private readonly messageHandlers: Array<(p: Packet) => void> = [];
  private readonly messageSentHandlers: Array<(info: SentInfo) => void> = [];
  private readonly closeHandlers: Array<(ev?: unknown) => void> = [];
  private readonly errorHandlers: Array<(e: unknown) => void> = [];

  async connect(): Promise<void> {
    this._connected = true;
  }

  async send(packet: Packet): Promise<void> {
    this.sent.push(packet);
    for (const cb of this.messageSentHandlers) cb({ messageId: packet.messageId });

    if (
      packet.packetType === PacketType.Request &&
      this.responder !== null
    ) {
      const responsePayload = this.responder(packet);
      if (responsePayload !== undefined) {
        const responseBizType =
          this.responseBizTypeFor?.(packet.bizType) ?? packet.bizType;
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
  }

  async close(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  onMessage(cb: (packet: Packet) => void): void {
    this.messageHandlers.push(cb);
  }
  onMessageSent(cb: (info: SentInfo) => void): void {
    this.messageSentHandlers.push(cb);
  }
  onClose(cb: (event?: unknown) => void): void {
    this.closeHandlers.push(cb);
  }
  onError(cb: (error: unknown) => void): void {
    this.errorHandlers.push(cb);
  }

  fireMessage(packet: Packet): void {
    for (const cb of this.messageHandlers) cb(packet);
  }
  fireClose(ev?: unknown): void {
    this._connected = false;
    for (const cb of this.closeHandlers) cb(ev);
  }
  fireError(e: unknown): void {
    for (const cb of this.errorHandlers) cb(e);
  }
}
