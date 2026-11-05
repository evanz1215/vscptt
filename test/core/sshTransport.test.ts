import type { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { SshConnectError, connectSsh, fingerprintOf } from '../../src/core/transport/sshTransport';

interface Seen {
  user?: string;
  method?: string;
  pty?: { cols: number; rows: number; term: string };
  received: string;
}

const hostKey = utils.generateKeyPairSync('ed25519');
const servers: Server[] = [];

/** A local SSH server that behaves like PTT's guest entry: 'none' auth, a pty, a shell that greets and echoes. */
async function startServer(options: { closeAfterGreeting?: boolean } = {}) {
  const seen: Seen = { received: '' };
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      seen.user = ctx.username;
      seen.method = ctx.method;
      if (ctx.method === 'none') {
        ctx.accept();
      } else {
        ctx.reject(['none']);
      }
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty, _reject, info) => {
          seen.pty = { cols: info.cols, rows: info.rows, term: info.term };
          acceptPty?.();
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('splash guest\r\n');
          if (options.closeAfterGreeting) {
            stream.exit(0);
            stream.end();
            return;
          }
          stream.on('data', (d: Buffer) => {
            seen.received += d.toString('utf8');
            stream.write(d);
          });
        });
      });
    });
    client.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen };
}

const serverFingerprint = () => {
  const parsed = utils.parseKey(hostKey.public);
  if (parsed instanceof Error) throw parsed;
  return fingerprintOf((Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH());
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const firstData = (t: { onData(l: (d: Uint8Array) => void): () => void }) =>
  new Promise<string>((resolve) => {
    let done = false;
    const off = t.onData((d) => {
      if (!done) {
        done = true;
        resolve(Buffer.from(d).toString('utf8'));
        queueMicrotask(() => off()); // replayed data arrives before `off` is assigned
      }
    });
  });

describe('SSH transport', () => {
  it('logs in as the guest user with no password, on an 80x24 pty, and keeps the early splash', async () => {
    const { port, seen } = await startServer();
    const asked: string[] = [];
    const t = await connectSsh({
      host: '127.0.0.1',
      port,
      verifyHostKey: (fp) => (asked.push(fp), true),
    });
    // Attach late on purpose: the greeting must not be lost.
    await new Promise((r) => setTimeout(r, 50));
    expect(await firstData(t)).toContain('splash guest');

    expect(asked).toEqual([serverFingerprint()]);
    expect(seen.user).toBe('bbsu');
    expect(seen.method).toBe('none');
    expect(seen.pty).toMatchObject({ cols: 80, rows: 24 });
    expect(t.isOpen).toBe(true);

    const echoed = firstData(t);
    t.send('中文\r');
    expect(await echoed).toBe('中文\r');
    expect(seen.received).toBe('中文\r');

    const closed = new Promise((r) => t.onClose(r));
    t.close();
    await closed;
    expect(t.isOpen).toBe(false);
  });

  it('refuses the connection, before any data, when the host key is not trusted', async () => {
    const { port, seen } = await startServer();
    const error = await connectSsh({ host: '127.0.0.1', port, verifyHostKey: () => false }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(SshConnectError);
    expect((error as SshConnectError).hostKeyFingerprint).toBe(serverFingerprint());
    expect(seen.user).toBeUndefined(); // never got as far as logging in
  });

  it('treats a verifier that throws as a refusal', async () => {
    const { port } = await startServer();
    const error = await connectSsh({
      host: '127.0.0.1',
      port,
      verifyHostKey: () => Promise.reject(new Error('storage broken')),
    }).catch((e: unknown) => e);
    expect((error as SshConnectError).hostKeyFingerprint).toBe(serverFingerprint());
  });

  it('fails with a connect error when nothing listens', async () => {
    const { port } = await startServer();
    await new Promise((r) => servers.pop()!.close(r));
    const error = await connectSsh({ host: '127.0.0.1', port, verifyHostKey: () => true }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(SshConnectError);
    expect((error as SshConnectError).hostKeyFingerprint).toBeUndefined();
  });

  it('reports the close when the server ends the session', async () => {
    const { port } = await startServer({ closeAfterGreeting: true });
    const t = await connectSsh({ host: '127.0.0.1', port, verifyHostKey: () => true });
    const info = await new Promise((r) => t.onClose(r));
    expect(info).toMatchObject({ reason: 'bbs disconnected' });
    expect(t.isOpen).toBe(false);
    t.send('ignored'); // must not throw after the close
  });
});
