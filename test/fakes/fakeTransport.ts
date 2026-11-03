import type { CloseInfo, Transport } from '../../src/core/transport/transport';

/**
 * In-memory Transport. Tests call push() to play server output and read `sent` to see what the client typed.
 * Like the real WebSocket transport, it keeps output that arrives before the first listener and tells a
 * late close listener that the connection already closed.
 */
export class FakeTransport implements Transport {
  readonly sent: string[] = [];
  isOpen = true;

  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(info: CloseInfo) => void>();
  private readonly early: Uint8Array[] = [];
  private closeInfo: CloseInfo | undefined;

  constructor(private readonly onSend?: (data: string, transport: FakeTransport) => void) {}

  send(data: string | Uint8Array): void {
    if (!this.isOpen) {
      throw new Error('FakeTransport is closed');
    }
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.sent.push(text);
    this.onSend?.(text, this);
  }

  close(): void {
    this.serverClose({ code: 1000, reason: 'closed by client' });
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    for (const bytes of this.early.splice(0)) {
      listener(bytes);
    }
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (info: CloseInfo) => void): () => void {
    this.closeListeners.add(listener);
    if (this.closeInfo) {
      const info = this.closeInfo;
      queueMicrotask(() => listener(info));
    }
    return () => this.closeListeners.delete(listener);
  }

  /** Play server output (UTF-8 text, or raw bytes for other encodings). */
  push(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (this.dataListeners.size === 0) {
      this.early.push(bytes);
      return;
    }
    for (const l of this.dataListeners) {
      l(bytes);
    }
  }

  /** Simulate the server dropping the connection. */
  serverClose(info: CloseInfo = { code: 1006 }): void {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    this.closeInfo = info;
    for (const l of this.closeListeners) {
      l(info);
    }
  }
}
