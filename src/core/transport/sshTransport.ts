import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import type { CloseInfo, Transport } from './transport';

export const PTT_SSH_HOST = 'ptt.cc';
export const PTT_SSH_PORT = 22;
/** PTT's guest entry for SSH: no password, the BBS login screen follows (docs/plan.md 2.1). */
export const PTT_SSH_USER = 'bbsu';

export interface SshTransportOptions {
  host?: string;
  port?: number;
  username?: string;
  connectTimeoutMs?: number;
  /**
   * Decides whether to trust the server, given its key's fingerprint in OpenSSH form ("SHA256:..."). Called
   * before anything is sent; false refuses the connection.
   */
  verifyHostKey: (fingerprint: string) => boolean | Promise<boolean>;
}

export class SshConnectError extends Error {
  constructor(
    message: string,
    /** Set when the connection was refused because the host key was not trusted. */
    readonly hostKeyFingerprint?: string
  ) {
    super(message);
    this.name = 'SshConnectError';
  }
}

/** The fingerprint `ssh-keygen -lf` prints for a raw public key blob. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function connectSsh(options: SshTransportOptions): Promise<Transport> {
  const {
    host = PTT_SSH_HOST,
    port = PTT_SSH_PORT,
    username = PTT_SSH_USER,
    connectTimeoutMs = 10_000,
    verifyHostKey,
  } = options;

  return new Promise((resolve, reject) => {
    const client = new Client();
    const dataListeners = new Set<(data: Uint8Array) => void>();
    const closeListeners = new Set<(info: CloseInfo) => void>();
    // The splash screen can arrive before the caller attaches a listener; keep it and replay it.
    const early: Uint8Array[] = [];
    let opened = false;
    let open = false;
    let refused: string | undefined;
    let closeInfo: CloseInfo | undefined;

    const emitClose = (info: CloseInfo) => {
      open = false;
      if (closeInfo) {
        return;
      }
      closeInfo = info;
      for (const l of closeListeners) {
        l(info);
      }
    };

    const fail = (message: string) => {
      client.end();
      reject(new SshConnectError(message, refused));
    };

    client.on('error', (error: Error) => {
      if (!opened) {
        fail(
          refused ? `SSH host key not trusted: ${refused}` : `SSH connect failed: ${error.message}`
        );
      } else {
        emitClose({ error });
      }
    });
    client.on('close', () => {
      if (!opened) {
        fail(refused ? `SSH host key not trusted: ${refused}` : 'SSH connection closed');
      }
      emitClose({ reason: 'ssh closed' });
    });

    client.on('ready', () => {
      // The screen parsers assume PTT's 80x24 terminal.
      client.shell({ term: 'vt100', cols: 80, rows: 24 }, (error, stream) => {
        if (error) {
          fail(`SSH shell failed: ${error.message}`);
          return;
        }
        opened = true;
        open = true;
        stream.on('data', (data: Buffer) => {
          if (dataListeners.size === 0) {
            early.push(data);
            return;
          }
          for (const l of dataListeners) {
            l(data);
          }
        });
        stream.on('close', () => {
          emitClose({ reason: 'bbs disconnected' });
          client.end();
        });
        resolve({
          get isOpen() {
            return open;
          },
          send(data) {
            if (open) {
              stream.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
            }
          },
          close() {
            stream.end();
            client.end();
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

    client.connect({
      host,
      port,
      username,
      readyTimeout: connectTimeoutMs,
      authHandler: ['none'],
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const fingerprint = fingerprintOf(key);
        Promise.resolve()
          .then(() => verifyHostKey(fingerprint))
          .then(
            (ok) => {
              if (!ok) {
                refused = fingerprint;
              }
              verify(ok);
            },
            () => {
              refused = fingerprint;
              verify(false);
            }
          );
      },
    });
  });
}
