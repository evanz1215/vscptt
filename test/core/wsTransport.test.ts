import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { PTT_WS_ORIGIN, WsConnectError, connectWs } from '../../src/core/transport/wsTransport';

let server: WebSocketServer | undefined;

afterEach(async () => {
  if (server) {
    for (const c of server.clients) {
      c.terminate();
    }
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
});

const listen = (options: ConstructorParameters<typeof WebSocketServer>[0] = {}) =>
  new Promise<{ wss: WebSocketServer; url: string }>((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options }, () => {
      resolve({ wss, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` });
    });
    server = wss;
  });

describe('connectWs', () => {
  it('sends the PTT web terminal Origin by default', async () => {
    let seenOrigin: string | undefined;
    const { url } = await listen({
      verifyClient: (info: { origin: string }) => {
        seenOrigin = info.origin;
        return true;
      },
    });
    const t = await connectWs({ url });
    expect(seenOrigin).toBe(PTT_WS_ORIGIN);
    t.close();
  });

  it('exchanges bytes in both directions', async () => {
    const { wss, url } = await listen();
    wss.on('connection', (socket) => {
      socket.on('message', (data) =>
        socket.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]))
      );
      socket.send(Buffer.from('hello'));
    });

    const t = await connectWs({ url });
    const received: string[] = [];
    t.onData((d) => received.push(Buffer.from(d).toString()));
    await new Promise((r) => setTimeout(r, 30));
    t.send('ping');
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toEqual(['hello', 'echo:ping']);
    expect(t.isOpen).toBe(true);
    t.close();
  });

  it('sends strings and bytes as binary frames (the PTT gateway ignores text frames)', async () => {
    const { wss, url } = await listen();
    const frames: Array<{ binary: boolean; text: string }> = [];
    wss.on('connection', (socket) => {
      socket.on('message', (data, isBinary) =>
        frames.push({ binary: isBinary, text: (data as Buffer).toString() })
      );
    });

    const t = await connectWs({ url });
    t.send('as string');
    t.send(new TextEncoder().encode('as bytes'));
    await new Promise((r) => setTimeout(r, 50));

    expect(frames).toEqual([
      { binary: true, text: 'as string' },
      { binary: true, text: 'as bytes' },
    ]);
    t.close();
  });

  it('does not lose server output that arrives before the first listener is attached', async () => {
    const { wss, url } = await listen();
    wss.on('connection', (socket) => {
      socket.send(Buffer.from('splash-1'));
      socket.send(Buffer.from('splash-2'));
    });

    const t = await connectWs({ url });
    await new Promise((r) => setTimeout(r, 50)); // data has arrived; nobody is listening yet
    const received: string[] = [];
    t.onData((d) => received.push(Buffer.from(d).toString()));

    expect(received).toEqual(['splash-1', 'splash-2']);
    t.close();
  });

  it('tells a late close listener that the connection already closed', async () => {
    const { wss, url } = await listen();
    wss.on('connection', (socket) => socket.close(1000, 'early'));

    const t = await connectWs({ url });
    await new Promise((r) => setTimeout(r, 80));
    const closes: Array<{ code?: number; reason?: string }> = [];
    t.onClose((info) => closes.push(info));
    await new Promise((r) => setTimeout(r, 10));

    expect(closes).toEqual([{ code: 1000, reason: 'early' }]);
  });

  it('reports the HTTP status when the handshake is rejected', async () => {
    const { url } = await listen({
      verifyClient: (_info: unknown, cb: (ok: boolean, code?: number, msg?: string) => void) =>
        cb(false, 403, 'Forbidden'),
    });
    const error = await connectWs({ url }).catch((e) => e);
    expect(error).toBeInstanceOf(WsConnectError);
    expect((error as WsConnectError).statusCode).toBe(403);
  });

  it('fails with WsConnectError when nothing is listening', async () => {
    const { wss, url } = await listen();
    await new Promise((r) => wss.close(r));
    server = undefined;
    const error = await connectWs({ url, connectTimeoutMs: 1000 }).catch((e) => e);
    expect(error).toBeInstanceOf(WsConnectError);
  });

  it('notifies close listeners once, with the close code', async () => {
    const { wss, url } = await listen();
    wss.on('connection', (socket) => setTimeout(() => socket.close(1000, 'bye'), 20));
    const t = await connectWs({ url });
    const closes: Array<{ code?: number; reason?: string }> = [];
    t.onClose((info) => closes.push(info));
    await new Promise((r) => setTimeout(r, 120));
    expect(closes).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(t.isOpen).toBe(false);
  });
});
