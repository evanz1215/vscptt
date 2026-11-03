import WebSocket from 'ws';
import type { CloseInfo, Transport } from './transport';

export const PTT_WS_URL = 'wss://ws.ptt.cc/bbs';
// The gateway rejects other origins with 403 (verified 2026-11-03, see docs/plan.md D11).
export const PTT_WS_ORIGIN = 'https://term.ptt.cc';

export interface WsTransportOptions {
  url?: string;
  origin?: string;
  connectTimeoutMs?: number;
}

export class WsConnectError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = 'WsConnectError';
  }
}

export function connectWs(options: WsTransportOptions = {}): Promise<Transport> {
  const { url = PTT_WS_URL, origin = PTT_WS_ORIGIN, connectTimeoutMs = 10_000 } = options;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, handshakeTimeout: connectTimeoutMs });
    const dataListeners = new Set<(data: Uint8Array) => void>();
    const closeListeners = new Set<(info: CloseInfo) => void>();
    // PTT sends its splash screen immediately; it can arrive in the same tick as 'open', before the
    // caller has attached a listener. Keep it and replay it to the first listener.
    const early: Uint8Array[] = [];
    let opened = false;
    let closeInfo: CloseInfo | undefined;

    const emitClose = (info: CloseInfo) => {
      if (closeInfo) {
        return;
      }
      closeInfo = info;
      for (const l of closeListeners) {
        l(info);
      }
    };

    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      reject(
        new WsConnectError(`WebSocket handshake rejected: HTTP ${res.statusCode}`, res.statusCode)
      );
    });

    ws.on('error', (error: Error) => {
      if (!opened) {
        reject(new WsConnectError(`WebSocket connect failed: ${error.message}`));
      } else {
        emitClose({ error });
      }
    });

    ws.on('close', (code: number, reason: Buffer) =>
      emitClose({ code, reason: reason.toString() })
    );

    ws.on('message', (data: WebSocket.RawData) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (dataListeners.size === 0) {
        early.push(bytes);
        return;
      }
      for (const l of dataListeners) {
        l(bytes);
      }
    });

    ws.on('open', () => {
      opened = true;
      resolve({
        get isOpen() {
          return ws.readyState === WebSocket.OPEN;
        },
        send(data) {
          // The gateway only reads binary frames; a text frame is silently ignored.
          ws.send(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { binary: true });
        },
        close() {
          ws.close();
        },
        onData(listener) {
          dataListeners.add(listener);
          for (const bytes of early.splice(0)) {
            listener(bytes);
          }
          return () => dataListeners.delete(listener);
        },
        onClose(listener) {
          closeListeners.add(listener);
          if (closeInfo) {
            const info = closeInfo;
            queueMicrotask(() => listener(info));
          }
          return () => closeListeners.delete(listener);
        },
      });
    });
  });
}
