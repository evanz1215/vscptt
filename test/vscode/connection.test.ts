import { describe, expect, it } from 'vitest';
import { NotLoggedInError } from '../../src/core/errors';
import type { ConnectionState } from '../../src/vscode/connection';
import { FakeUi, makeHarness } from './helpers';

const board = [{ id: 'M.1.A.001', author: 'a', title: 'first' }];

describe('login', () => {
  it('logs in with typed credentials and walks connecting -> ready', async () => {
    const h = makeHarness({ bbs: { boards: { Dev: board } } });
    const states: ConnectionState[] = [];
    h.manager.onDidChangeState((s) => states.push(s));

    expect(await h.manager.login()).toBe(true);

    expect(states).toEqual(['connecting', 'ready']);
    expect(h.manager.state).toBe('ready');
    expect(h.manager.username).toBe('alice');
    expect((await h.manager.service.getBoardPage('Dev')).articles).toHaveLength(1);
    expect(h.transports[0]!.sent.filter((k) => k === 'secret\r')).toHaveLength(1); // typed once
  });

  it('asks whether to remember only after a login that worked', async () => {
    const h = makeHarness();
    h.ui.remember = 'password';
    await h.manager.login();
    expect(h.ui.askedRemember).toBe(1);
    expect(await h.store.load()).toEqual({ username: 'alice', password: 'secret' });
  });

  it('remembers only the account name when asked to', async () => {
    const h = makeHarness();
    h.ui.remember = 'usernameOnly';
    await h.manager.login();
    expect(await h.store.load()).toEqual({ username: 'alice' });
    expect(h.secrets.size).toBe(0);
  });

  it('remembers nothing when asked to', async () => {
    const h = makeHarness();
    await h.manager.login();
    expect(await h.store.load()).toBeUndefined();
  });

  it('a wrong password is explained, not remembered, and does not ask to remember', async () => {
    const h = makeHarness();
    h.ui.credentials = [{ username: 'alice', password: 'wrong-pass' }];
    h.ui.remember = 'password';

    expect(await h.manager.login()).toBe(false);

    expect(h.manager.state).toBe('disconnected');
    expect(h.ui.errors).toHaveLength(1);
    expect(h.ui.errors[0]).toContain('帳號或密碼錯誤');
    expect(h.ui.errors.join(' ')).not.toContain('wrong-pass');
    expect(h.ui.askedRemember).toBe(0);
    expect(await h.store.load()).toBeUndefined();
  });

  it('does nothing when the user cancels the credential box', async () => {
    const h = makeHarness();
    h.ui.credentials = [undefined];
    expect(await h.manager.login()).toBe(false);
    expect(h.transports).toHaveLength(0); // never even connected
    expect(h.ui.errors).toEqual([]);
  });

  it('reports a server that cannot be reached, and stays usable', async () => {
    const h = makeHarness();
    const { WsConnectError } = await import('../../src/core/transport/wsTransport');
    let calls = 0;
    const { ConnectionManager } = await import('../../src/vscode/connection');
    const manager = new ConnectionManager({
      connect: async () => {
        calls++;
        throw new WsConnectError('refused', 403);
      },
      ui: h.ui,
      store: h.store,
      settings: () => h.settings,
    });
    expect(await manager.login()).toBe(false);
    expect(calls).toBe(1);
    expect(h.ui.errors[0]).toContain('HTTP 403');
    expect(manager.state).toBe('disconnected');
  });

  it('shares one attempt between concurrent calls', async () => {
    const h = makeHarness();
    const results = await Promise.all([h.manager.login(), h.manager.login(), h.manager.login()]);
    expect(results).toEqual([true, true, true]);
    expect(h.transports).toHaveLength(1);
    expect(h.ui.askedCredentials).toHaveLength(1);
  });

  it('returns true at once when already logged in', async () => {
    const h = makeHarness();
    await h.manager.login();
    expect(await h.manager.login()).toBe(true);
    expect(h.transports).toHaveLength(1);
  });

  it('refuses to hand out a service while not logged in', () => {
    const h = makeHarness();
    expect(() => h.manager.service).toThrow(NotLoggedInError);
  });
});

describe('remembered credentials', () => {
  async function remembered() {
    const h = makeHarness();
    await h.store.remember('alice', 'secret');
    return h;
  }

  it('uses the saved password without asking anything', async () => {
    const h = await remembered();
    expect(await h.manager.login({ useSaved: true })).toBe(true);
    expect(h.ui.askedCredentials).toHaveLength(0);
    expect(h.ui.askedRemember).toBe(0);
  });

  it('asks when told to use the saved password but there is none', async () => {
    const h = makeHarness();
    await h.store.rememberUsername('alice');
    await h.manager.login({ useSaved: true });
    expect(h.ui.askedCredentials).toEqual([{ username: 'alice' }]); // pre-filled with the account name
  });

  it('forgets a saved password that stopped working, so auto-login cannot loop', async () => {
    const h = makeHarness();
    await h.store.remember('alice', 'old-password');
    expect(await h.manager.login({ useSaved: true })).toBe(false);
    expect(h.ui.errors[0]).toContain('帳號或密碼錯誤');
    expect(await h.store.load()).toEqual({ username: 'alice' });
  });

  it('forgets an old password when the user logs in differently and declines to remember', async () => {
    const h = makeHarness({ bbs: { users: { alice: 'secret', bob: 'pw' } } });
    await h.store.remember('alice', 'secret');
    h.ui.credentials = [{ username: 'bob', password: 'pw' }];
    await h.manager.login({ useSaved: false }); // asked on purpose
    expect(await h.store.load()).toEqual({ username: 'alice' });
    expect(h.secrets.size).toBe(0);
  });

  it('logs in with a remembered password without asking, even when started by hand', async () => {
    const h = await remembered();
    h.ui.credentials = []; // asking would hand back nothing: the login would be cancelled

    expect(await h.manager.login()).toBe(true);
    expect(h.manager.state).toBe('ready');
  });

  it('auto-login works only when enabled and a password is saved', async () => {
    const off = await remembered();
    await off.manager.autoLogin();
    expect(off.transports).toHaveLength(0);

    const on = makeHarness({ settings: { autoLogin: true } });
    await on.manager.autoLogin(); // enabled but nothing saved
    expect(on.transports).toHaveLength(0);

    await on.store.remember('alice', 'secret');
    await on.manager.autoLogin();
    expect(on.manager.state).toBe('ready');
    expect(on.ui.askedCredentials).toHaveLength(0);
  });
});

describe('review findings', () => {
  it('stays logged in when the secret store fails while remembering', async () => {
    const h = makeHarness();
    h.ui.remember = 'password';
    h.store.remember = async () => {
      throw new Error('no keyring');
    };

    expect(await h.manager.login()).toBe(true);

    expect(h.manager.state).toBe('ready');
    expect(h.manager.service).toBeDefined();
    expect(h.ui.errors.join(' ')).toContain('無法儲存');
    expect(h.bbs).toHaveLength(1); // no second connection
  });

  it('keeps a saved password when the remember box is dismissed', async () => {
    const h = makeHarness();
    await h.store.remember('alice', 'old-secret');
    h.ui.remember = 'cancel';
    h.ui.credentials = [{ username: 'alice', password: 'secret' }];
    await h.manager.login({ useSaved: false });
    expect(await h.store.load()).toEqual({ username: 'alice', password: 'old-secret' });
  });

  it('does not leave a live connection behind when shut down during login', async () => {
    const h = makeHarness();
    const login = h.manager.login();
    await h.manager.shutdown();
    await login;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.manager.state).toBe('disconnected');
    expect(h.transports.every((t) => t.isClosed)).toBe(true);
  });
});

describe('the account is already logged in elsewhere', () => {
  it('logs the other connection out only after the user agrees', async () => {
    const h = makeHarness({ bbs: { duplicateLogin: true } });
    h.ui.kickOther = true;
    expect(await h.manager.login()).toBe(true);
    expect(h.ui.askedKick).toBe(1);
    expect(h.bbs[0]!.duplicateAnswer).toBe('y');
  });

  it('keeps the other connection when the user says no, and explains why the login failed', async () => {
    const h = makeHarness({ bbs: { duplicateLogin: true } });
    h.ui.kickOther = false;
    expect(await h.manager.login()).toBe(false);
    expect(h.bbs[0]!.duplicateAnswer).toBe('n');
    expect(h.ui.errors[0]).toContain('已在別處登入');
    expect(h.manager.state).toBe('disconnected');
  });

  it('does not ask when the setting already says to keep or to kick', async () => {
    const keep = makeHarness({
      bbs: { duplicateLogin: true },
      settings: { duplicateSession: 'keep' },
    });
    await keep.manager.login();
    expect(keep.ui.askedKick).toBe(0);
    expect(keep.bbs[0]!.duplicateAnswer).toBe('n');

    const kick = makeHarness({
      bbs: { duplicateLogin: true },
      settings: { duplicateSession: 'kick' },
    });
    expect(await kick.manager.login()).toBe(true);
    expect(kick.ui.askedKick).toBe(0);
    expect(kick.bbs[0]!.duplicateAnswer).toBe('y');
  });
});

describe('logout and shutdown', () => {
  it('logs out politely, not just by hanging up', async () => {
    const h = makeHarness();
    await h.manager.login();
    const states: ConnectionState[] = [];
    h.manager.onDidChangeState((s) => states.push(s));

    await h.manager.logout();

    expect(states).toEqual(['disconnected']);
    expect(h.transports[0]!.sent.slice(-3)).toEqual(['G\r', 'Y\r', ' ']);
    expect(h.manager.username).toBeUndefined();
    expect(h.ui.notifiedDisconnected).toBe(0); // we closed it ourselves
  });

  it('logout when not logged in is harmless', async () => {
    const h = makeHarness();
    await expect(h.manager.logout()).resolves.toBeUndefined();
  });

  it('shutdown logs out and can be called twice', async () => {
    const h = makeHarness();
    await h.manager.login();
    await h.manager.shutdown();
    await h.manager.shutdown();
    expect(h.transports[0]!.sent.slice(-3)).toEqual(['G\r', 'Y\r', ' ']);
  });

  it('shutdown gives up after the time limit when the server never answers', async () => {
    const h = makeHarness({ shutdownTimeoutMs: 80 });
    await h.manager.login();
    // The server goes silent: it no longer reacts to anything we type.
    const t = h.transports[0]!;
    (t as { send: unknown }).send = () => {};

    const started = Date.now();
    await h.manager.shutdown();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('a connection that drops by itself', () => {
  it('tells the user once, and does not reconnect unless asked', async () => {
    const h = makeHarness();
    await h.manager.login();
    const states: ConnectionState[] = [];
    h.manager.onDidChangeState((s) => states.push(s));

    h.transports[0]!.serverClose({ code: 1006 });
    await new Promise((r) => setTimeout(r, 30));

    expect(states).toEqual(['disconnected']);
    expect(h.ui.notifiedDisconnected).toBe(1);
    expect(h.transports).toHaveLength(1); // no automatic reconnect
    expect(() => h.manager.service).toThrow(NotLoggedInError);
  });

  it('reconnects with the saved password when the user chooses to', async () => {
    const h = makeHarness();
    h.ui.remember = 'password';
    await h.manager.login();
    h.ui.disconnectedAnswer = 'reconnect';

    h.transports[0]!.serverClose({ code: 1006 });
    await new Promise((r) => setTimeout(r, 150));

    expect(h.manager.state).toBe('ready');
    expect(h.transports).toHaveLength(2);
    expect(h.ui.askedCredentials).toHaveLength(1); // only the first login asked
  });

  it('reconnect() closes the old connection and logs in again', async () => {
    const h = makeHarness();
    h.ui.remember = 'password';
    await h.manager.login();
    expect(await h.manager.reconnect()).toBe(true);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.sent.slice(-3)).toEqual(['G\r', 'Y\r', ' ']);
  });
});

describe('settings reach the session', () => {
  it('uses the configured timeouts and cache times', async () => {
    const h = makeHarness({
      settings: {
        settleMs: 120,
        stepTimeoutMs: 7000,
        keepAliveSeconds: 0,
        duplicateSession: 'keep',
      },
    });
    await h.manager.login();
    const session = h.manager.service.session;
    expect(session.settings).toMatchObject({
      settleMs: 120,
      stepTimeoutMs: 7000,
      keepAliveMs: 0,
      duplicateSession: 'keep',
    });
  });
});

describe('FakeUi', () => {
  it('is the harness default and answers "no" to everything risky', () => {
    const ui = new FakeUi();
    expect(ui.kickOther).toBe(false);
    expect(ui.remember).toBe('no');
  });
});
