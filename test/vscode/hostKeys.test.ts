import { describe, expect, it } from 'vitest';
import { HostKeyStore } from '../../src/vscode/hostKeys';

const memento = () => {
  const state = new Map<string, unknown>();
  return {
    state,
    get: <T>(k: string) => state.get(k) as T | undefined,
    update: async (k: string, v: unknown) =>
      void (v === undefined ? state.delete(k) : state.set(k, v)),
  };
};

describe('HostKeyStore', () => {
  it('trusts and remembers the first key, and says so once', async () => {
    const m = memento();
    const told: string[] = [];
    const keys = new HostKeyStore(m, (fp) => told.push(fp));
    expect(await keys.check('SHA256:aaa')).toBe(true);
    expect(await keys.check('SHA256:aaa')).toBe(true);
    expect(told).toEqual(['SHA256:aaa']);
    expect(keys.known).toBe('SHA256:aaa');
  });

  it('refuses a different key later, and does not overwrite the remembered one', async () => {
    const keys = new HostKeyStore(memento());
    await keys.check('SHA256:aaa');
    expect(await keys.check('SHA256:bbb')).toBe(false);
    expect(keys.known).toBe('SHA256:aaa');
  });

  it('trusts a new key again only after the remembered one is forgotten', async () => {
    const keys = new HostKeyStore(memento());
    await keys.check('SHA256:aaa');
    await keys.forget();
    expect(keys.known).toBeUndefined();
    expect(await keys.check('SHA256:bbb')).toBe(true);
  });
});
