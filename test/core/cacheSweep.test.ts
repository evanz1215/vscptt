import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TtlCache } from '../../src/core/cache/ttlCache';
import { CACHE_SWEEP_MS, PttService } from '../../src/core/service';
import type { Session, SessionState } from '../../src/core/session/session';

/** Only what the service needs at construction: a state listener it can be told about. */
function stubSession() {
  let listener: (state: SessionState) => void = () => {};
  const session = {
    onStateChange: (l: (state: SessionState) => void) => {
      listener = l;
      return () => {};
    },
  } as unknown as Session;
  return { session, setState: (s: SessionState) => listener(s) };
}

const articlesOf = (service: PttService) =>
  (service as unknown as { articles: TtlCache<unknown> }).articles;

afterEach(() => {
  vi.useRealTimers();
});

describe('the cache sweep while idle', () => {
  it('drops expired articles on its own, with nothing new read', () => {
    vi.useFakeTimers();
    const { session } = stubSession();
    const service = new PttService(session, { cacheTtlSeconds: { article: 60 } });
    articlesOf(service).set('article:dev:1', {}, 60_000);
    articlesOf(service).set('article:dev:2', {}, CACHE_SWEEP_MS * 3);

    vi.advanceTimersByTime(CACHE_SWEEP_MS);
    expect(articlesOf(service).size).toBe(1); // the expired one went, the live one stayed
  });

  it('stops when the connection ends, so no timer is left behind', () => {
    vi.useFakeTimers();
    const { session, setState } = stubSession();
    new PttService(session);
    expect(vi.getTimerCount()).toBe(1);
    setState('ready');
    expect(vi.getTimerCount()).toBe(1);
    setState('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });
});
