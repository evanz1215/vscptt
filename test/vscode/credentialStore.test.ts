import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/vscode/credentialStore';

function stores() {
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  const store = new CredentialStore(
    {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    {
      get: <T>(k: string) => state.get(k) as T | undefined,
      update: async (k, v) => void (v === undefined ? state.delete(k) : state.set(k, v)),
    }
  );
  return { store, secrets, state };
}

describe('CredentialStore', () => {
  it('has nothing saved at first', async () => {
    expect(await stores().store.load()).toBeUndefined();
  });

  it('keeps the password only in secret storage and the account name in plain state', async () => {
    const { store, secrets, state } = stores();
    await store.remember('alice', 'hunter2');

    expect(await store.load()).toEqual({ username: 'alice', password: 'hunter2' });
    expect([...secrets.values()]).toEqual(['hunter2']);
    expect(JSON.stringify([...state.entries()])).not.toContain('hunter2');
  });

  it('remembers just the account name when the user declines to save the password', async () => {
    const { store, secrets } = stores();
    await store.rememberUsername('alice');
    expect(await store.load()).toEqual({ username: 'alice' });
    expect(secrets.size).toBe(0);
  });

  it('can forget the password but keep the account name', async () => {
    const { store } = stores();
    await store.remember('alice', 'hunter2');
    await store.forgetPassword();
    expect(await store.load()).toEqual({ username: 'alice' });
  });

  it('clear() removes both', async () => {
    const { store, secrets, state } = stores();
    await store.remember('alice', 'hunter2');
    await store.clear();
    expect(await store.load()).toBeUndefined();
    expect(secrets.size).toBe(0);
    expect(state.size).toBe(0);
  });

  it('replacing the account replaces the saved password too', async () => {
    const { store } = stores();
    await store.remember('alice', 'one');
    await store.remember('bob', 'two');
    expect(await store.load()).toEqual({ username: 'bob', password: 'two' });
  });
});
