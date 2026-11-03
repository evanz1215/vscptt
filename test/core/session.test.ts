import { describe, expect, it } from 'vitest';
import {
  ConnectionClosedError,
  DuplicateLoginDeclinedError,
  InvalidArgumentError,
  LoginFailedError,
  NotLoggedInError,
  TooFrequentError,
} from '../../src/core/errors';
import { WaitTimeoutError } from '../../src/core/queue/waitFor';
import { isBoardSelectPrompt, isMainMenu } from '../../src/core/screens/prompts';
import {
  type DuplicateSessionPolicy,
  Session,
  type SessionOptions,
  type SessionState,
} from '../../src/core/session/session';
import { FakeBbs, type FakeBbsOptions } from '../fakes/fakeBbs';
import { FakeTransport } from '../fakes/fakeTransport';

const creds = { username: 'alice', password: 'secret' };

function connect(bbsOptions: FakeBbsOptions = {}, sessionOptions: SessionOptions = {}) {
  const bbs = new FakeBbs(bbsOptions);
  const transport = bbs.connect();
  const session = new Session(transport, { keepAliveMs: 0, ...sessionOptions });
  return { bbs, transport, session };
}

describe('login', () => {
  it('walks splash -> password -> welcome -> main menu and ends ready', async () => {
    const { session, transport, bbs } = connect();
    const states: SessionState[] = [];
    session.onStateChange((s) => states.push(s));

    await session.login(creds);

    expect(session.state).toBe('ready');
    expect(states).toEqual(['loggingIn', 'ready']);
    expect(isMainMenu(session.lines)).toBe(true);
    expect(bbs.loggedInAs).toBe('alice');
    // The comma asks for UTF-8; the password is typed once; the welcome screen is dismissed with a key.
    expect(transport.sent).toEqual(['alice,\r', 'secret\r', ' ']);
    expect(session.terminal.encoding).toBe('utf-8');
  });

  it('fails with LoginFailedError(wrongPassword), closes the connection, and never leaks the password', async () => {
    const { session, transport } = connect();
    const error = await session
      .login({ username: 'alice', password: 'wrong-pass' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(LoginFailedError);
    expect(error.reason).toBe('wrongPassword');
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('wrong-pass');
    expect(session.state).toBe('disconnected');
    expect(transport.isOpen).toBe(false);
  });

  it('fails with LoginFailedError(noAccount) before typing any password', async () => {
    const { session, transport } = connect();
    const error = await session.login({ username: 'nobody', password: 'secret' }).catch((e) => e);

    expect(error).toBeInstanceOf(LoginFailedError);
    expect(error.reason).toBe('noAccount');
    expect(transport.sent).toEqual(['nobody,\r']); // the password was never sent
  });

  it('reports "please try later" as TooFrequentError', async () => {
    const { session } = connect({ tryLater: true });
    await expect(session.login(creds)).rejects.toBeInstanceOf(TooFrequentError);
    expect(session.state).toBe('disconnected');
  });

  it('presses Enter on the frequent-login notice and carries on', async () => {
    const { session, transport } = connect({ frequentNotice: true });
    await session.login(creds);
    expect(session.state).toBe('ready');
    expect(transport.sent).toEqual(['alice,\r', 'secret\r', '\r', ' ']);
  });

  it('declines the "delete failed attempts" prompt, so the account keeps its record', async () => {
    const { session, bbs } = connect({ deleteAttempts: true });
    await session.login(creds);
    expect(bbs.deleteAttemptsAnswer).toBe('n');
  });

  describe('duplicate-login prompt', () => {
    // Verified on the live server: answering "n" (keep the other connection) makes PTT close this one.
    const kicks: Array<[DuplicateSessionPolicy, (() => Promise<boolean>) | undefined]> = [
      ['kick', undefined],
      ['ask', async () => true],
    ];
    it.each(kicks)('policy %s answers y and logs in', async (policy, callback) => {
      const { session, bbs, transport } = connect(
        { duplicateLogin: true },
        { duplicateSession: policy, onDuplicateSession: callback }
      );
      await session.login(creds);
      expect(session.state).toBe('ready');
      expect(bbs.duplicateAnswer).toBe('y');
      expect(transport.sent).toContain('y\r');
    });

    const keeps: Array<[DuplicateSessionPolicy, (() => Promise<boolean>) | undefined]> = [
      ['keep', undefined],
      ['ask', async () => false],
      ['ask', undefined], // nobody to ask: never log another connection out
    ];
    it.each(keeps)(
      'policy %s answers n; PTT then refuses this connection',
      async (policy, callback) => {
        const { session, bbs } = connect(
          { duplicateLogin: true },
          { duplicateSession: policy, onDuplicateSession: callback }
        );
        const error = await session.login(creds).catch((e) => e);
        expect(error).toBeInstanceOf(DuplicateLoginDeclinedError);
        expect(error.code).toBe('duplicateLogin');
        expect(bbs.duplicateAnswer).toBe('n');
        expect(session.state).toBe('disconnected');
      }
    );
  });

  it('rejects a bad username or password before touching the network', async () => {
    const { session, transport } = connect();
    await expect(session.login({ username: 'a,b', password: 'x' })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(session.login({ username: '1abc', password: 'x' })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(session.login({ username: 'alice', password: '' })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(session.login({ username: 'alice', password: 'a\rb' })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    expect(transport.sent).toEqual([]);
    expect(session.state).toBe('connecting');
  });

  it('cannot be used to log in twice', async () => {
    const { session } = connect();
    await session.login(creds);
    await expect(session.login(creds)).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('fails at once, not after a timeout, when the connection drops mid-login', async () => {
    const transport = new FakeTransport(); // a server that never answers
    const session = new Session(transport, { keepAliveMs: 0 });
    const started = Date.now();
    const pending = session.login(creds).catch((e) => e);
    setTimeout(() => transport.serverClose({ code: 1006 }), 20);

    expect(await pending).toBeInstanceOf(ConnectionClosedError);
    expect(Date.now() - started).toBeLessThan(1000); // the login prompt wait alone would take 10 s
    expect(session.state).toBe('disconnected');
  });
});

describe('session', () => {
  it('assertReady tells "not logged in" from "disconnected"', async () => {
    const { session } = connect();
    expect(() => session.assertReady()).toThrow(NotLoggedInError);
    await session.login(creds);
    expect(() => session.assertReady()).not.toThrow();
    await session.logout();
    expect(() => session.assertReady()).toThrow(ConnectionClosedError);
  });

  it('send() throws ConnectionClosedError once the connection is gone', async () => {
    const { session, transport } = connect();
    await session.login(creds);
    transport.serverClose({ code: 1006 });
    expect(() => session.send('x')).toThrow(ConnectionClosedError);
  });

  it('rejects an operation that is waiting when the connection drops', async () => {
    const { session, transport } = connect();
    await session.login(creds);
    const waiting = session
      .waitFor(() => false, 'something that never comes', 5000)
      .catch((e) => e);
    transport.serverClose({ code: 1006 });
    expect(await waiting).toBeInstanceOf(ConnectionClosedError);
  });

  it('logs out through the main menu and the server closes the connection', async () => {
    const { session, transport } = connect();
    await session.login(creds);
    await session.logout();

    expect(session.state).toBe('disconnected');
    expect(await session.closed).toMatchObject({ code: 1000, reason: 'bbs disconnected' });
    expect(transport.sent.slice(-3)).toEqual(['G\r', 'Y\r', ' ']);
  });

  it('logout is harmless when already disconnected', async () => {
    const { session } = connect();
    await session.login(creds);
    await session.logout();
    await expect(session.logout()).resolves.toBeUndefined();
  });

  it('toMainMenu climbs out of a prompt', async () => {
    const { session } = connect();
    await session.login(creds);
    await session.run(async () => {
      session.send('s');
      await session.waitFor(isBoardSelectPrompt, 'the prompt');
      await session.toMainMenu();
    });
    expect(isMainMenu(session.lines)).toBe(true);
  });

  it('toMainMenu never confirms an exit by accident', async () => {
    const { session, bbs } = connect();
    await session.login(creds);
    await session.run(async () => {
      session.send('{'); // any key; then ← on the main menu asks whether to leave
      session.send('\x1b[D');
      await session.waitFor((l) => l.join('\n').includes('您確定要離開'), 'the exit prompt');
      await session.toMainMenu();
    });
    expect(isMainMenu(session.lines)).toBe(true);
    expect(session.state).toBe('ready');
    expect(bbs.screenMode).toBe('main');
  });

  describe('keep-alive', () => {
    it('sends the redraw key while idle, through the queue, and stops after logout', async () => {
      const { session, transport } = connect({}, { keepAliveMs: 40 });
      await session.login(creds);
      const sentAfterLogin = transport.sent.length;

      await new Promise((r) => setTimeout(r, 250));
      const keepAlives = transport.sent.slice(sentAfterLogin).filter((k) => k === '\x0c');
      expect(keepAlives.length).toBeGreaterThanOrEqual(2);
      expect(isMainMenu(session.lines)).toBe(true); // a redraw leaves the screen as it was

      await session.logout();
      const total = transport.sent.length;
      await new Promise((r) => setTimeout(r, 120));
      expect(transport.sent.length).toBe(total);
    });

    it('does not run before login completes', async () => {
      const { transport } = connect({}, { keepAliveMs: 20 });
      await new Promise((r) => setTimeout(r, 100));
      expect(transport.sent).toEqual([]);
    });
  });
});

describe('lifecycle and masking (review findings)', () => {
  it('login on a connection that already closed says so', async () => {
    const { session, transport } = connect();
    transport.serverClose({ code: 1006 });
    await session.closed;
    await expect(session.login(creds)).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('logout before logging in just hangs up and types nothing', async () => {
    const { session, transport } = connect();
    await session.logout();
    expect(transport.sent).toEqual([]);
    expect(transport.isOpen).toBe(false);
    expect(session.state).toBe('disconnected');
  });

  it('treats a duplicate-login callback that throws as "do not kick"', async () => {
    const { session, bbs } = connect(
      { duplicateLogin: true },
      {
        duplicateSession: 'ask',
        onDuplicateSession: async () => {
          throw new Error('dialog failed');
        },
      }
    );
    await expect(session.login(creds)).rejects.toBeInstanceOf(DuplicateLoginDeclinedError);
    expect(bbs.duplicateAnswer).toBe('n');
  });

  it('masks the account name in snapshots and in timeout errors', async () => {
    const { session } = connect();
    await session.login(creds);
    expect(session.lines.join('\n')).toContain('alice'); // the status line shows it
    expect(session.snapshot().join('\n')).not.toMatch(/alice/i);
    expect(session.snapshot().join('\n')).toContain('<user>');

    const error = await session.waitFor(() => false, 'nothing', 30).catch((e) => e);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).snapshot.join('\n')).not.toMatch(/alice/i);
  });

  it('never leaves the password anywhere a caller could read it', async () => {
    const { session } = connect();
    const error = await session
      .login({ username: 'alice', password: 'wrong-pass' })
      .catch((e) => e);
    expect(session.terminal.text()).not.toContain('wrong-pass');
    expect(JSON.stringify(session.snapshot())).not.toContain('wrong-pass');
    expect(`${error.stack}`).not.toContain('wrong-pass');
  });
});

describe('prompts that echo what is typed (found by the live test)', () => {
  it('answers each login prompt exactly once, even though typing changes the screen', async () => {
    const { session, transport, bbs } = connect(
      { duplicateLogin: true, deleteAttempts: true },
      { duplicateSession: 'kick' }
    );
    await session.login(creds);

    expect(session.state).toBe('ready');
    expect(bbs.screenMode).toBe('main'); // a second answer would have opened the namelist menu
    expect(isMainMenu(session.lines)).toBe(true);
    // one answer per prompt: keep the attempt log ("n"), then answer the duplicate-login question ("y")
    expect(transport.sent.filter((k) => k === 'n\r' || k === 'y\r')).toEqual(['n\r', 'y\r']);
  });

  it('answers the exit prompt once when walking back to the main menu', async () => {
    const { session, transport, bbs } = connect();
    await session.login(creds);
    await session.run(async () => {
      session.send('\x1b[D'); // Left on the main menu asks whether to leave
      await session.waitFor((l) => l.join('\n').includes('您確定要離開'), 'the exit prompt');
      await session.toMainMenu();
    });
    expect(bbs.screenMode).toBe('main');
    expect(transport.sent.filter((k) => k === 'N\r')).toHaveLength(1);
  });
});
