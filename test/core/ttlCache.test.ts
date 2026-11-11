import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/core/cache/ttlCache';

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TtlCache', () => {
  it('returns a value until its TTL passes', () => {
    const c = clock();
    const cache = new TtlCache<string>(c.now);
    cache.set('a', 'x', 100);
    expect(cache.get('a')).toBe('x');
    c.advance(99);
    expect(cache.get('a')).toBe('x');
    c.advance(1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('runs the loader once for concurrent callers and caches the result', async () => {
    const cache = new TtlCache<number>(clock().now);
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };
    const results = await Promise.all([
      cache.getOrLoad('k', 100, loader),
      cache.getOrLoad('k', 100, loader),
      cache.getOrLoad('k', 100, loader),
    ]);
    expect(results).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
    await cache.getOrLoad('k', 100, loader);
    expect(calls).toBe(1); // served from the cache
  });

  it('loads again after expiry', async () => {
    const c = clock();
    const cache = new TtlCache<number>(c.now);
    let n = 0;
    const loader = async () => ++n;
    expect(await cache.getOrLoad('k', 50, loader)).toBe(1);
    c.advance(51);
    expect(await cache.getOrLoad('k', 50, loader)).toBe(2);
  });

  it('does not cache a failed load and lets the next caller retry', async () => {
    const cache = new TtlCache<number>(clock().now);
    let n = 0;
    const flaky = async () => {
      if (++n === 1) {
        throw new Error('boom');
      }
      return n;
    };
    await expect(cache.getOrLoad('k', 100, flaky)).rejects.toThrow('boom');
    expect(await cache.getOrLoad('k', 100, flaky)).toBe(2);
  });

  it('skips caching when shouldCache says no', async () => {
    const cache = new TtlCache<{ ok: boolean }>(clock().now);
    let n = 0;
    const loader = async () => ({ ok: ++n > 1 });
    await cache.getOrLoad('k', 100, loader, (v) => v.ok);
    await cache.getOrLoad('k', 100, loader, (v) => v.ok);
    expect(n).toBe(2); // first result was not kept
    await cache.getOrLoad('k', 100, loader, (v) => v.ok);
    expect(n).toBe(2); // second was
  });

  it('clear() empties the cache and stops an in-flight load from repopulating it', async () => {
    const cache = new TtlCache<string>(clock().now);
    cache.set('old', 'v', 1000);
    const pending = cache.getOrLoad('slow', 1000, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'late';
    });
    cache.clear();
    expect(cache.get('old')).toBeUndefined();
    expect(await pending).toBe('late'); // the caller still gets its answer
    expect(cache.get('slow')).toBeUndefined(); // but it was not stored
  });

  it('deleteWhere removes matching keys only', () => {
    const cache = new TtlCache<number>(clock().now);
    cache.set('a:1', 1, 100);
    cache.set('a:2', 2, 100);
    cache.set('b:1', 3, 100);
    cache.deleteWhere((k) => k.startsWith('a:'));
    expect([cache.get('a:1'), cache.get('a:2'), cache.get('b:1')]).toEqual([
      undefined,
      undefined,
      3,
    ]);
  });

  it('drops expired entries when something new is stored, but keeps live ones', () => {
    const c = clock();
    const cache = new TtlCache<string>(c.now);
    cache.set('old', 'x', 100);
    cache.set('long', 'y', 1000);
    c.advance(100);
    cache.set('new', 'z', 100);
    expect(cache.size).toBe(2); // 'old' is gone without ever being read again
    expect(cache.get('long')).toBe('y');
  });

  it('prune() alone drops only what has expired', () => {
    const c = clock();
    const cache = new TtlCache<string>(c.now);
    cache.set('a', 'x', 100);
    cache.set('b', 'y', 200);
    c.advance(150);
    cache.prune();
    expect(cache.size).toBe(1);
    expect(cache.get('b')).toBe('y');
  });
});
