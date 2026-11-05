import type { PttServiceOptions } from '../core/service';
import type { DuplicateSessionPolicy, SessionOptions } from '../core/session/session';

export type TransportKind = 'websocket' | 'ssh';

export interface VscpttSettings {
  /** How to reach PTT: its WebSocket gateway, or SSH to ptt.cc. */
  transport: TransportKind;
  duplicateSession: DuplicateSessionPolicy;
  autoLogin: boolean;
  settleMs: number;
  stepTimeoutMs: number;
  keepAliveSeconds: number;
  /** Articles longer than this many screens are cut off. */
  articleMaxPages: number;
  /** How many searches the "搜尋結果" group keeps. */
  searchMaxSaved: number;
  /** Show a picture when hovering an image link in an article. */
  previewImages: boolean;
  cache: {
    latestPageSeconds: number;
    olderPageSeconds: number;
    articleSeconds: number;
    favoritesSeconds: number;
  };
}

/** Every setting the code reads, relative to the `vscptt.` prefix. package.json must declare each of them. */
export const SETTING_KEYS = [
  'login.duplicateSession',
  'login.autoLogin',
  'connection.transport',
  'connection.settleMs',
  'connection.stepTimeoutMs',
  'connection.keepAliveSeconds',
  'article.maxPages',
  'search.maxSaved',
  'preview.images',
  'cache.latestPageSeconds',
  'cache.olderPageSeconds',
  'cache.articleSeconds',
  'cache.favoritesSeconds',
] as const;

export const DEFAULT_SETTINGS: VscpttSettings = {
  transport: 'websocket',
  duplicateSession: 'ask',
  autoLogin: false,
  settleMs: 80,
  stepTimeoutMs: 5000,
  keepAliveSeconds: 30,
  articleMaxPages: 30,
  searchMaxSaved: 10,
  previewImages: true,
  cache: {
    latestPageSeconds: 60,
    olderPageSeconds: 600,
    articleSeconds: 300,
    favoritesSeconds: 300,
  },
};

const POLICIES: readonly DuplicateSessionPolicy[] = ['ask', 'kick', 'keep'];

/** A number from the user's settings, forced into a range that cannot break the client. */
function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

/** Reads the settings; anything missing or out of range falls back to a safe value. */
export function readSettings(get: (key: (typeof SETTING_KEYS)[number]) => unknown): VscpttSettings {
  const d = DEFAULT_SETTINGS;
  const policy = get('login.duplicateSession');
  const keepAlive = number(get('connection.keepAliveSeconds'), d.keepAliveSeconds, 0, 600);
  return {
    transport: get('connection.transport') === 'ssh' ? 'ssh' : 'websocket',
    duplicateSession: POLICIES.includes(policy as DuplicateSessionPolicy)
      ? (policy as DuplicateSessionPolicy)
      : d.duplicateSession,
    autoLogin: get('login.autoLogin') === true,
    settleMs: number(get('connection.settleMs'), d.settleMs, 20, 1000),
    stepTimeoutMs: number(get('connection.stepTimeoutMs'), d.stepTimeoutMs, 1000, 60_000),
    // 0 turns the keep-alive off; anything shorter than 10 s would only add traffic.
    keepAliveSeconds: keepAlive === 0 ? 0 : Math.max(keepAlive, 10),
    articleMaxPages: Math.round(number(get('article.maxPages'), d.articleMaxPages, 1, 100)),
    searchMaxSaved: Math.round(number(get('search.maxSaved'), d.searchMaxSaved, 1, 30)),
    previewImages: get('preview.images') !== false,
    cache: {
      latestPageSeconds: number(
        get('cache.latestPageSeconds'),
        d.cache.latestPageSeconds,
        0,
        86_400
      ),
      olderPageSeconds: number(get('cache.olderPageSeconds'), d.cache.olderPageSeconds, 0, 86_400),
      articleSeconds: number(get('cache.articleSeconds'), d.cache.articleSeconds, 0, 86_400),
      favoritesSeconds: number(get('cache.favoritesSeconds'), d.cache.favoritesSeconds, 0, 86_400),
    },
  };
}

export function toSessionOptions(
  s: VscpttSettings,
  onDuplicateSession: () => Promise<boolean>
): SessionOptions {
  return {
    settleMs: s.settleMs,
    stepTimeoutMs: s.stepTimeoutMs,
    keepAliveMs: s.keepAliveSeconds * 1000,
    duplicateSession: s.duplicateSession,
    onDuplicateSession,
  };
}

export function toServiceOptions(s: VscpttSettings): PttServiceOptions {
  return {
    maxArticlePages: s.articleMaxPages,
    cacheTtlSeconds: {
      latestPage: s.cache.latestPageSeconds,
      olderPage: s.cache.olderPageSeconds,
      article: s.cache.articleSeconds,
      favorites: s.cache.favoritesSeconds,
    },
  };
}
