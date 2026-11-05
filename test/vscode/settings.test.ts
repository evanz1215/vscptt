import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  readSettings,
  toServiceOptions,
  toSessionOptions,
} from '../../src/vscode/settings';

const from = (values: Record<string, unknown>) => (key: string) => values[key];

describe('readSettings', () => {
  it('returns the defaults when nothing is set', () => {
    expect(readSettings(from({}))).toEqual(DEFAULT_SETTINGS);
  });

  it('reads valid values', () => {
    const s = readSettings(
      from({
        'login.duplicateSession': 'keep',
        'login.autoLogin': true,
        'connection.settleMs': 120,
        'connection.stepTimeoutMs': 8000,
        'connection.keepAliveSeconds': 45,
        'article.maxPages': 12,
        'search.maxSaved': 5,
        'preview.images': false,
        'cache.latestPageSeconds': 10,
        'cache.olderPageSeconds': 20,
        'cache.articleSeconds': 30,
        'cache.favoritesSeconds': 40,
      })
    );
    expect(s).toEqual({
      duplicateSession: 'keep',
      autoLogin: true,
      settleMs: 120,
      stepTimeoutMs: 8000,
      keepAliveSeconds: 45,
      articleMaxPages: 12,
      searchMaxSaved: 5,
      previewImages: false,
      cache: {
        latestPageSeconds: 10,
        olderPageSeconds: 20,
        articleSeconds: 30,
        favoritesSeconds: 40,
      },
    });
  });

  it('falls back for values of the wrong type or an unknown policy', () => {
    const s = readSettings(
      from({
        'login.duplicateSession': 'always',
        'login.autoLogin': 'yes',
        'connection.settleMs': 'fast',
        'connection.stepTimeoutMs': Number.NaN,
        'cache.articleSeconds': null,
      })
    );
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('forces numbers into a safe range', () => {
    const s = readSettings(
      from({
        'connection.settleMs': 1,
        'connection.stepTimeoutMs': 1e9,
        'connection.keepAliveSeconds': 3,
        'cache.latestPageSeconds': -5,
        'cache.articleSeconds': 1e12,
        'article.maxPages': 100_000,
        'search.maxSaved': 0.2,
      })
    );
    expect(s.articleMaxPages).toBe(100);
    expect(s.searchMaxSaved).toBe(1);
    expect(s.settleMs).toBe(20);
    expect(s.stepTimeoutMs).toBe(60_000);
    expect(s.keepAliveSeconds).toBe(10); // anything shorter would only add traffic
    expect(s.cache.latestPageSeconds).toBe(0);
    expect(s.cache.articleSeconds).toBe(86_400);
  });

  it('keeps 0 as "keep-alive off"', () => {
    expect(readSettings(from({ 'connection.keepAliveSeconds': 0 })).keepAliveSeconds).toBe(0);
  });

  it('reads exactly the keys it declares', () => {
    const asked = new Set<string>();
    readSettings((key) => {
      asked.add(key);
      return undefined;
    });
    expect([...asked].sort()).toEqual([...SETTING_KEYS].sort());
  });
});

describe('option mapping', () => {
  it('passes the settings on to the session and the service', () => {
    const s = readSettings(
      from({
        'login.duplicateSession': 'kick',
        'connection.settleMs': 100,
        'connection.stepTimeoutMs': 7000,
        'connection.keepAliveSeconds': 20,
        'article.maxPages': 7,
        'cache.latestPageSeconds': 1,
        'cache.olderPageSeconds': 2,
        'cache.articleSeconds': 3,
        'cache.favoritesSeconds': 4,
      })
    );
    const ask = async () => true;
    expect(toSessionOptions(s, ask)).toEqual({
      settleMs: 100,
      stepTimeoutMs: 7000,
      keepAliveMs: 20_000,
      duplicateSession: 'kick',
      onDuplicateSession: ask,
    });
    expect(toServiceOptions(s)).toEqual({
      maxArticlePages: 7,
      cacheTtlSeconds: { latestPage: 1, olderPage: 2, article: 3, favorites: 4 },
    });
  });
});

describe('settings that decide whether another connection is logged out', () => {
  it('cannot be set by a workspace file, only by the user', async () => {
    const { readFileSync } = await import('node:fs');
    const props = JSON.parse(readFileSync('package.json', 'utf8')).contributes.configuration
      .properties as Record<string, { scope?: string }>;
    expect(props['vscptt.login.duplicateSession']!.scope).toBe('application');
    expect(props['vscptt.login.autoLogin']!.scope).toBe('application');
  });
});
