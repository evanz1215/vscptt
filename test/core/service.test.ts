import { describe, expect, it } from 'vitest';
import {
  ArticleDeletedError,
  ArticleMismatchError,
  ConnectionClosedError,
  InvalidArgumentError,
  NotLoggedInError,
} from '../../src/core/errors';
import type { BoardPage } from '../../src/core/models';
import { PttService, type PttServiceOptions } from '../../src/core/service';
import { Session } from '../../src/core/session/session';
import { FakeBbs, type FakeArticle, type FakeBbsOptions } from '../fakes/fakeBbs';
import type { FakeTransport } from '../fakes/fakeTransport';

const PGDN = '\x1b[6~';

function article(i: number, extra: Partial<FakeArticle> = {}): FakeArticle {
  return {
    id: `M.${1000 + i}.A.${String(i).padStart(3, '0')}`,
    author: `user${i % 7}`,
    title: `[測試] 第${i}篇`,
    push: String(i % 100),
    body: [`body of ${i}`, 'second line'],
    pushes: [{ kind: '推', user: 'bob', text: `hi ${i}` }],
    ...extra,
  };
}

/** `count` normal articles numbered 1..count, then `pinned` pinned ones. */
function board(count: number, pinned = 0): FakeArticle[] {
  return [
    ...Array.from({ length: count }, (_, i) => article(i + 1)),
    ...Array.from({ length: pinned }, (_, i) =>
      article(9000 + i, { pinned: true, title: `[公告] 置頂${i}`, author: 'mod' })
    ),
  ];
}

async function setup(
  boards: Record<string, FakeArticle[]>,
  options: { favorites?: string[]; bbs?: FakeBbsOptions; service?: PttServiceOptions } = {}
) {
  const bbs = new FakeBbs({ boards, favorites: options.favorites ?? [], ...options.bbs });
  const transport = bbs.connect();
  const session = new Session(transport, { keepAliveMs: 0 });
  let nowMs = 0;
  const service = new PttService(session, {
    boardEnterTimeoutMs: 150,
    now: () => nowMs,
    ...options.service,
  });
  await service.login({ username: 'alice', password: 'secret' });
  return { bbs, transport, session, service, advance: (ms: number) => (nowMs += ms) };
}

const count = (t: FakeTransport, key: string): number => t.sent.filter((k) => k === key).length;

async function walk(service: PttService, boardName: string): Promise<BoardPage[]> {
  const pages: BoardPage[] = [];
  let cursor: BoardPage['next'];
  for (let i = 0; i < 50; i++) {
    const page = await service.getBoardPage(boardName, cursor);
    pages.push(page);
    if (!page.hasOlder) {
      return pages;
    }
    cursor = page.next;
  }
  throw new Error('paging did not end');
}

describe('favorites', () => {
  it('lists the boards in order', async () => {
    const { service } = await setup(
      { Dev: board(3), Ops: board(3) },
      { favorites: ['Dev', 'Ops'] }
    );
    const favorites = await service.getFavorites();
    expect(favorites.map((f) => f.name)).toEqual(['Dev', 'Ops']);
    expect(favorites[0]).toMatchObject({ category: '綜合', unread: true });
  });

  it('serves a second call from the cache without typing anything', async () => {
    const { service, transport } = await setup({ Dev: board(3) }, { favorites: ['Dev'] });
    await service.getFavorites();
    const sent = transport.sent.length;
    await service.getFavorites();
    expect(transport.sent.length).toBe(sent);
  });
});

describe('openBoard', () => {
  it('enters an existing board by name', async () => {
    const { service, session } = await setup({ Dev: board(3) });
    expect(await service.openBoard('Dev')).toBe(true);
    expect(session.lines[0]).toContain('看板《Dev》');
  });

  it('matches the name case-insensitively', async () => {
    const { service } = await setup({ Dev: board(3) });
    expect(await service.openBoard('dev')).toBe(true);
  });

  it('returns false for a board that does not exist, then keeps working', async () => {
    const { service } = await setup({ Dev: board(3) });
    expect(await service.openBoard('Nope')).toBe(false);
    expect(await service.openBoard('Dev')).toBe(true);
  });

  it('returns false when PTT completes the name to a different board', async () => {
    const { service } = await setup(
      { Dev: board(3), Ops: board(3) },
      { bbs: { autocomplete: { Dv: 'Ops' } } }
    );
    expect(await service.openBoard('Dv')).toBe(false);
    expect(await service.openBoard('Dev')).toBe(true);
  });

  it('refuses names that could be keystrokes', async () => {
    const { service, transport } = await setup({ Dev: board(1) });
    const sent = transport.sent.length;
    for (const bad of ['', 'a b', 'Dev\r', '../x', 'x'.repeat(40)]) {
      await expect(service.openBoard(bad)).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(transport.sent.length).toBe(sent);
  });
});

describe('getBoardPage', () => {
  it('returns the newest articles first, with pinned ones set apart', async () => {
    const { service } = await setup({ Dev: board(45, 2) });
    const page = await service.getBoardPage('Dev');

    expect(page.board).toBe('Dev');
    expect(page.articles[0]).toMatchObject({
      listNumber: 45,
      title: '[測試] 第45篇',
      isPinned: false,
      kind: 'normal',
    });
    expect(page.articles.map((a) => a.listNumber)).toEqual(
      Array.from({ length: 18 }, (_, i) => 45 - i) // the entry screen holds 20 rows, 2 are pinned
    );
    expect(page.pinned.map((a) => [a.pinnedIndex, a.title])).toEqual([
      [0, '[公告] 置頂0'],
      [1, '[公告] 置頂1'],
    ]);
    expect(page.hasOlder).toBe(true);
    expect(page.next).toEqual({ before: 28 });
  });

  it('pages back through every article exactly once, newest to oldest', async () => {
    const { service } = await setup({ Dev: board(45, 2) });
    const pages = await walk(service, 'Dev');
    const numbers = pages.flatMap((p) => p.articles.map((a) => a.listNumber));
    expect(numbers).toEqual(Array.from({ length: 45 }, (_, i) => 45 - i));
    expect(pages[0]!.pinned).toHaveLength(2);
    expect(pages.slice(1).every((p) => p.pinned.length === 0)).toBe(true);
    expect(pages.at(-1)!.hasOlder).toBe(false);
  });

  it('pages through a long board using full 20-row pages', async () => {
    const { service } = await setup({ Dev: board(100) });
    const pages = await walk(service, 'Dev');
    expect(pages.flatMap((p) => p.articles.map((a) => a.listNumber))).toEqual(
      Array.from({ length: 100 }, (_, i) => 100 - i)
    );
    expect(pages.map((p) => p.articles.length)).toEqual([20, 20, 20, 20, 20]);
  });

  it('handles a board with fewer articles than one screen', async () => {
    const { service } = await setup({ Dev: board(5, 1) });
    const page = await service.getBoardPage('Dev');
    expect(page.articles.map((a) => a.listNumber)).toEqual([5, 4, 3, 2, 1]);
    expect(page.hasOlder).toBe(false);
    expect(page.next).toBeUndefined();
    expect(page.pinned).toHaveLength(1);
  });

  it('reads deleted and reply entries', async () => {
    const articles = board(5);
    articles[1] = article(2, { kind: 'deleted' });
    articles[3] = article(4, { kind: 'reply', title: 'Re: [測試] 第1篇' });
    const { service } = await setup({ Dev: articles });
    const page = await service.getBoardPage('Dev');
    expect(page.articles.find((a) => a.listNumber === 2)?.kind).toBe('deleted');
    expect(page.articles.find((a) => a.listNumber === 4)?.kind).toBe('reply');
  });

  it('asks for a page after the first one without re-entering the board', async () => {
    const { service, transport } = await setup({ Dev: board(100) });
    const first = await service.getBoardPage('Dev');
    const sent = transport.sent.length;
    await service.getBoardPage('Dev', first.next);
    expect(transport.sent.slice(sent).some((k) => k.startsWith('s'))).toBe(false); // no board prompt
  });

  it('caches pages until their TTL passes, and invalidate() drops them', async () => {
    const { service, transport, advance } = await setup({ Dev: board(30) });
    await service.getBoardPage('Dev');
    const afterFirst = transport.sent.length;

    advance(30_000);
    await service.getBoardPage('Dev');
    expect(transport.sent.length).toBe(afterFirst); // still fresh (60 s)

    advance(31_000);
    await service.getBoardPage('Dev');
    expect(transport.sent.length).toBeGreaterThan(afterFirst); // expired

    const afterExpiry = transport.sent.length;
    service.invalidate('Dev');
    await service.getBoardPage('Dev');
    expect(transport.sent.length).toBeGreaterThan(afterExpiry);
  });

  it('runs overlapping calls one after another without mixing them up', async () => {
    const { service } = await setup({ Dev: board(30), Ops: board(12) });
    const [dev, ops, devArticle] = await Promise.all([
      service.getBoardPage('Dev'),
      service.getBoardPage('Ops'),
      service.getArticle({ board: 'Dev', listNumber: 3 }),
    ]);
    expect(dev.board).toBe('Dev');
    expect(dev.articles[0]!.listNumber).toBe(30);
    expect(ops.board).toBe('Ops');
    expect(ops.articles[0]!.listNumber).toBe(12);
    expect(devArticle.title).toBe('[測試] 第3篇');
  });

  it('rejects a board that does not exist', async () => {
    const { service } = await setup({ Dev: board(3) });
    await expect(service.getBoardPage('Nope')).rejects.toMatchObject({ code: 'boardNotFound' });
    expect((await service.getBoardPage('Dev')).articles).toHaveLength(3); // and recovers
  });
});

describe('getArticle', () => {
  it('opens a pinned article even when the board was left far from its end', async () => {
    const { service } = await setup({ Dev: board(60, 2) });
    const latest = await service.getBoardPage('Dev');
    await service.getBoardPage('Dev', latest.next); // leaves the list scrolled to older articles

    const a = await service.getArticle({
      board: 'Dev',
      isPinned: true,
      pinnedIndex: 1,
      title: '[公告] 置頂1',
    });
    expect(a.title).toContain('置頂1');
  });

  it('says at once that a deleted article has nothing to open, and the next one still works', async () => {
    const articles = board(10);
    articles[2] = article(3, { kind: 'deleted' });
    const { service } = await setup({ Dev: articles });

    const started = Date.now();
    await expect(service.getArticle({ board: 'Dev', listNumber: 3 })).rejects.toBeInstanceOf(
      ArticleDeletedError
    );
    expect(Date.now() - started).toBeLessThan(2000); // not a step timeout
    expect((await service.getArticle({ board: 'Dev', listNumber: 4 })).id).toBe('M.1004.A.004');
  });

  it('reads a normal article: header, body, pushes, ids, and marks it verified', async () => {
    const { service } = await setup({ Dev: board(10) });
    const a = await service.getArticle({ board: 'Dev', listNumber: 7, title: '[測試] 第7篇' });

    expect(a).toMatchObject({
      board: 'Dev',
      id: 'M.1007.A.007',
      title: '[測試] 第7篇',
      author: 'user0 (nick)',
      verified: true,
      pinnedMirror: false,
      truncated: false,
      url: 'https://www.ptt.cc/bbs/Dev/M.1007.A.007.html',
    });
    expect(a.aid).toMatch(/^#1/);
    expect(a.bodyLines.slice(0, 2)).toEqual(['body of 7', 'second line']);
    expect(a.pushes).toEqual([
      { kind: '推', userId: 'bob', content: 'hi 7', date: '11/01', time: '12:00' },
    ]);
  });

  it('reads every page of a long article and joins them without gaps or repeats', async () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const pushes = Array.from({ length: 30 }, (_, i) => ({
      kind: '→' as const,
      user: 'bob',
      text: `p${i}`,
    }));
    const { service, transport } = await setup({ Dev: [article(1, { body, pushes })] });

    const a = await service.getArticle({ board: 'Dev', listNumber: 1 });

    expect(a.bodyLines.slice(0, 100)).toEqual(body);
    expect(a.pushes.map((p) => p.content)).toEqual(pushes.map((p) => p.text));
    expect(count(transport, PGDN)).toBe(6); // 137 lines -> 7 screens
    expect(a.verified).toBe(true);
  });

  it('reads a short two-screen article whose last page repeats three rows', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    const { service } = await setup({ Dev: [article(1, { body, pushes: [] })] });
    const a = await service.getArticle({ board: 'Dev', listNumber: 1 });
    expect(a.bodyLines.slice(0, 30)).toEqual(body);
  });

  it('serves a known id from the cache without reading the pages again', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const { service, transport } = await setup({ Dev: [article(1, { body })] });
    const first = await service.getArticle({ board: 'Dev', listNumber: 1 });
    const pagesRead = count(transport, PGDN);

    const second = await service.getArticle({ board: 'Dev', listNumber: 1, id: first.id });
    expect(second).toEqual(first);
    const third = await service.getArticle({ board: 'Dev', listNumber: 1, id: first.id });
    expect(third).toEqual(first);
    expect(count(transport, PGDN)).toBe(pagesRead);
  });

  it('reads once when asked for the same article twice at the same time', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const { service, transport } = await setup({ Dev: [article(1, { body })] });
    const id = (await service.resolveArticleId({ board: 'Dev', listNumber: 1 })).id;

    await Promise.all([
      service.getArticle({ board: 'Dev', listNumber: 1, id }),
      service.getArticle({ board: 'Dev', listNumber: 1, id }),
    ]);
    expect(count(transport, PGDN)).toBe(3); // 68 lines = 4 screens = 3 page-downs; reading twice would be 6
  });

  describe('opening the wrong article (docs/plan.md 5.5)', () => {
    it('refuses when the list shifted and the entry is no longer the one that was resolved', async () => {
      const { service, bbs, transport } = await setup({ Dev: board(10) });
      const ref = { board: 'Dev', listNumber: 5 };
      const resolved = await service.resolveArticleId(ref);

      bbs.mutate('Dev', (a) => a.splice(2, 1)); // an earlier article disappears: every later number shifts
      expect(await service.openBoard('Dev')).toBe(true); // coming back to the board shows the new list

      const before = count(transport, PGDN);
      await expect(service.getArticle({ ...ref, id: resolved.id })).rejects.toBeInstanceOf(
        ArticleMismatchError
      );
      expect(count(transport, PGDN)).toBe(before); // it never opened the wrong article
      // and nothing wrong was cached: the correct id still reads the right article
      const right = await service.resolveArticleId({ board: 'Dev', listNumber: 4 });
      expect(right.id).toBe(resolved.id);
    });

    it('refuses before pressing Q when the list title no longer matches', async () => {
      const { service, bbs, transport } = await setup({ Dev: board(10) });
      bbs.mutate('Dev', (a) => a.splice(2, 1));
      await service.openBoard('Dev');

      const qBefore = count(transport, 'Q');
      await expect(
        service.getArticle({ board: 'Dev', listNumber: 5, title: '[測試] 第5篇' })
      ).rejects.toBeInstanceOf(ArticleMismatchError);
      expect(count(transport, 'Q')).toBe(qBefore);
    });

    it('refuses when the article opened is not the one the list entry names', async () => {
      const wrong = article(3, { bodyUrlId: 'M.9999.A.999' });
      const { service, transport } = await setup({ Dev: [article(1), article(2), wrong] });
      await expect(service.getArticle({ board: 'Dev', listNumber: 3 })).rejects.toBeInstanceOf(
        ArticleMismatchError
      );
      // not cached: a second attempt does the whole read again
      const readsBefore = count(transport, '\x1b[C');
      await expect(
        service.getArticle({ board: 'Dev', listNumber: 3, id: wrong.id })
      ).rejects.toBeInstanceOf(ArticleMismatchError);
      expect(count(transport, '\x1b[C')).toBeGreaterThan(readsBefore);
    });

    it('refuses an article from another board', async () => {
      const { service } = await setup({ Dev: [article(1, { headerBoard: 'Elsewhere' })] });
      await expect(service.getArticle({ board: 'Dev', listNumber: 1 })).rejects.toBeInstanceOf(
        ArticleMismatchError
      );
    });

    it('returns an article with no URL line as unverified and does not cache it', async () => {
      const { service, transport } = await setup({ Dev: [article(1, { bodyUrlId: null })] });
      const first = await service.getArticle({ board: 'Dev', listNumber: 1 });
      expect(first.verified).toBe(false);

      const opensBefore = count(transport, '\x1b[C');
      await service.getArticle({ board: 'Dev', listNumber: 1, id: first.id });
      expect(count(transport, '\x1b[C')).toBeGreaterThan(opensBefore); // read again, not served from cache
    });

    it('recovers after a refusal: the next request works', async () => {
      const { service } = await setup({
        Dev: [article(1, { headerBoard: 'Elsewhere' }), article(2)],
      });
      await expect(service.getArticle({ board: 'Dev', listNumber: 1 })).rejects.toBeInstanceOf(
        ArticleMismatchError
      );
      expect((await service.getArticle({ board: 'Dev', listNumber: 2 })).title).toBe(
        '[測試] 第2篇'
      );
    });
  });

  describe('pinned articles', () => {
    it('finds the right pinned entry among several', async () => {
      const { service } = await setup({ Dev: board(45, 3) });
      const a = await service.getArticle({ board: 'Dev', isPinned: true, pinnedIndex: 1 });
      expect(a.id).toBe(article(9001).id);
      expect(a.verified).toBe(true);
    });

    it('accepts an edited pinned entry whose list title differs from the title inside', async () => {
      const pinned = article(9000, {
        pinned: true,
        title: '[公告] 新標題',
        headerTitle: '[公告] 原本的標題',
      });
      const { service } = await setup({ Dev: [article(1), pinned] });
      const a = await service.getArticle({
        board: 'Dev',
        isPinned: true,
        pinnedIndex: 0,
        title: '[公告] 新標題',
      });
      expect(a.title).toBe('[公告] 原本的標題');
      expect(a.verified).toBe(true);
      expect(a.pinnedMirror).toBe(false); // same URL: just an edited title
    });

    it('marks a pinned entry whose body carries another article URL as a mirror', async () => {
      const pinned = article(9000, { pinned: true, title: '[公告] 置頂', bodyUrlId: 'M.1.A.ORIG' });
      const { service } = await setup({ Dev: [article(1), pinned] });
      const a = await service.getArticle({ board: 'Dev', isPinned: true, pinnedIndex: 0 });
      expect(a).toMatchObject({ verified: true, pinnedMirror: true });
    });

    it('refuses a pinned index that does not exist', async () => {
      const { service } = await setup({ Dev: board(5, 1) });
      await expect(
        service.getArticle({ board: 'Dev', isPinned: true, pinnedIndex: 4 })
      ).rejects.toBeInstanceOf(ArticleMismatchError);
    });
  });

  it('cuts off an article longer than the page limit and says so', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const { service, transport } = await setup(
      { Dev: [article(1, { body })] },
      { service: { maxArticlePages: 3 } }
    );
    const a = await service.getArticle({ board: 'Dev', listNumber: 1 });
    expect(a.truncated).toBe(true);
    expect(a.verified).toBe(false); // the URL line at the end was never read
    expect(count(transport, PGDN)).toBe(2);
    expect(a.bodyLines[0]).toBe('line 0');
  });

  it('validates the reference before typing anything', async () => {
    const { service, transport } = await setup({ Dev: board(3) });
    const sent = transport.sent.length;
    await expect(service.getArticle({ board: 'Dev' })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(service.getArticle({ board: 'Dev', listNumber: 0 })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(service.getArticle({ board: 'Dev', isPinned: true })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    expect(transport.sent.length).toBe(sent);
  });
});

describe('resolveArticleId', () => {
  it('returns the stable id, code and URL for a normal and a pinned entry', async () => {
    const { service } = await setup({ Dev: board(10, 1) });
    const normal = await service.resolveArticleId({ board: 'Dev', listNumber: 4 });
    expect(normal).toMatchObject({
      board: 'Dev',
      id: 'M.1004.A.004',
      url: 'https://www.ptt.cc/bbs/Dev/M.1004.A.004.html',
    });
    expect(normal.aid).toMatch(/^#1/);

    const pinned = await service.resolveArticleId({ board: 'Dev', isPinned: true, pinnedIndex: 0 });
    expect(pinned.id).toBe(article(9000).id);
  });

  it('is repeatable and leaves the list usable', async () => {
    const { service } = await setup({ Dev: board(10) });
    const a = await service.resolveArticleId({ board: 'Dev', listNumber: 4 });
    const b = await service.resolveArticleId({ board: 'Dev', listNumber: 4 });
    expect(b).toEqual(a);
    expect((await service.getBoardPage('Dev')).articles).toHaveLength(10);
  });
});

describe('connection problems and session state', () => {
  it('fails with ConnectionClosedError when the server drops mid-article, and later calls fail the same way', async () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const { service, transport } = await setup({ Dev: [article(1, { body })] });

    let pageDowns = 0;
    const original = transport.send.bind(transport);
    (transport as { send: unknown }).send = (data: string) => {
      original(data);
      if (data === PGDN && ++pageDowns === 2) {
        transport.serverClose({ code: 1006 });
      }
    };

    await expect(service.getArticle({ board: 'Dev', listNumber: 1 })).rejects.toBeInstanceOf(
      ConnectionClosedError
    );
    await expect(service.getBoardPage('Dev')).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('refuses to work before login', async () => {
    const bbs = new FakeBbs({ boards: { Dev: board(1) } });
    const service = new PttService(new Session(bbs.connect(), { keepAliveMs: 0 }));
    await expect(service.getFavorites()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(service.getBoardPage('Dev')).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('forgets cached results when the connection ends', async () => {
    const { service, transport } = await setup({ Dev: board(5) });
    const page = await service.getBoardPage('Dev');
    expect(page.articles).toHaveLength(5);
    transport.serverClose({ code: 1006 });
    await service.session.closed;
    await expect(service.getBoardPage('Dev')).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it('logout() closes the connection and clears the caches', async () => {
    const { service, session } = await setup({ Dev: board(5) });
    await service.getBoardPage('Dev');
    await service.logout();
    expect(session.state).toBe('disconnected');
    await expect(service.getBoardPage('Dev')).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});

// ---- review findings (R1, R3, R4, R6) ----

describe('inputs that would not type as plain digits (R1)', () => {
  const bad = [1e21, Number.MAX_SAFE_INTEGER, 10_000_000, 0, -3, 2.5, Number.NaN];

  it.each(bad)('rejects listNumber %s before typing anything', async (listNumber) => {
    const { service, transport } = await setup({ Dev: board(5) });
    const sent = transport.sent.length;
    await expect(service.getArticle({ board: 'Dev', listNumber })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    await expect(service.resolveArticleId({ board: 'Dev', listNumber })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    expect(transport.sent.length).toBe(sent);
  });

  it.each([1e21, Number.MAX_SAFE_INTEGER, 10_000_000, 0, -3, 2.5, Number.NaN])(
    'rejects cursor.before %s before typing anything',
    async (before) => {
      const { service, transport } = await setup({ Dev: board(5) });
      const sent = transport.sent.length;
      await expect(service.getBoardPage('Dev', { before })).rejects.toBeInstanceOf(
        InvalidArgumentError
      );
      expect(transport.sent.length).toBe(sent);
    }
  );

  it('rejects a pinnedIndex that is not a small non-negative integer', async () => {
    const { service, transport } = await setup({ Dev: board(5, 1) });
    const sent = transport.sent.length;
    for (const pinnedIndex of [1e21, -1, 0.5, Number.NaN]) {
      await expect(
        service.getArticle({ board: 'Dev', isPinned: true, pinnedIndex })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(transport.sent.length).toBe(sent);
  });
});

describe('articles that quote another article URL (R3)', () => {
  it('checks the system footer (the last URL line), not a URL quoted in the body', async () => {
    const quoted = '※ 文章網址: https://www.ptt.cc/bbs/Dev/M.5.A.555.html';
    const { service } = await setup({
      Dev: [article(1, { body: ['original post:', quoted, 'my comments'] })],
    });
    const a = await service.getArticle({ board: 'Dev', listNumber: 1 });
    expect(a.verified).toBe(true);
    expect(a.url).toBe('https://www.ptt.cc/bbs/Dev/M.1001.A.001.html');
    expect(a.bodyLines).toContain(quoted); // the quote is still part of the text
  });

  it('still refuses when the footer itself names another article', async () => {
    const quoted = '※ 文章網址: https://www.ptt.cc/bbs/Dev/M.1001.A.001.html';
    const { service } = await setup({
      Dev: [article(1, { body: [quoted], bodyUrlId: 'M.9.A.999' })],
    });
    await expect(service.getArticle({ board: 'Dev', listNumber: 1 })).rejects.toBeInstanceOf(
      ArticleMismatchError
    );
  });
});

describe('list text that looks like prompts (R4)', () => {
  const hostile = [
    article(1),
    article(2, { title: '請按任意鍵繼續' }),
    article(3, { title: '您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N]' }),
  ];

  it('is read as ordinary titles, and the list stays usable', async () => {
    const { service } = await setup({ Dev: hostile, Ops: board(3) });
    const page = await service.getBoardPage('Dev');
    expect(page.articles.map((a) => a.title)).toEqual([
      '您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N]',
      '請按任意鍵繼續',
      '[測試] 第1篇',
    ]);
  });

  it('does not make toMainMenu press Enter or Space on a board list', async () => {
    const { service, transport } = await setup({ Dev: hostile, Ops: board(3) });
    await service.getBoardPage('Dev'); // leaves the hostile list on screen, last row = the "exit" title
    const before = transport.sent.length;

    await service.getFavorites(); // starts with toMainMenu from that list

    const typed = transport.sent.slice(before);
    expect(typed[0]).toBe('\x1b[D'); // Left, not "N\r" and not " "
    expect(typed).not.toContain('N\r');
  });

  it('can still be walked back from after opening such an article', async () => {
    const { service } = await setup({ Dev: hostile, Ops: board(3) });
    const a = await service.getArticle({ board: 'Dev', listNumber: 3 });
    expect(a.verified).toBe(true);
    expect((await service.getBoardPage('Ops')).board).toBe('Ops');
  });
});

describe('cached results cannot be changed by callers (R6)', () => {
  it('returns copies of pages, articles and favorites', async () => {
    const { service } = await setup({ Dev: board(5) }, { favorites: ['Dev'] });

    const page = await service.getBoardPage('Dev');
    page.articles.length = 0;
    page.articles.push({ title: 'tampered' } as never);
    expect((await service.getBoardPage('Dev')).articles).toHaveLength(5);

    const first = await service.getArticle({ board: 'Dev', listNumber: 2 });
    first.bodyLines.push('tampered');
    first.pushes.length = 0;
    const again = await service.getArticle({ board: 'Dev', listNumber: 2, id: first.id });
    expect(again.bodyLines).not.toContain('tampered');
    expect(again.pushes).toHaveLength(1);

    const favorites = await service.getFavorites();
    favorites.length = 0;
    expect(await service.getFavorites()).toHaveLength(1);
  });
});

describe('favorites that span several screens', () => {
  const names = (n: number) =>
    Array.from({ length: n }, (_, i) => `Board${String(i + 1).padStart(2, '0')}`);

  it.each([[45], [41], [21], [20], [19], [1]])('reads all %i favorites in order', async (n) => {
    const boards = Object.fromEntries(names(n).map((b) => [b, board(1)]));
    const { service } = await setup(boards, {
      favorites: names(n),
      service: { nextPageTimeoutMs: 150 },
    });
    const favorites = await service.getFavorites();
    expect(favorites.map((f) => f.name)).toEqual(names(n));
  });

  it('reads an empty favorites list', async () => {
    const { service } = await setup({ Dev: board(1) }, { service: { nextPageTimeoutMs: 150 } });
    expect(await service.getFavorites()).toEqual([]);
  });
});

describe('operations when the connection drops', () => {
  it('resolveArticleId and getBoardPage fail with ConnectionClosedError, not a timeout', async () => {
    const { service, transport } = await setup({ Dev: board(5) });
    const started = Date.now();
    const original = transport.send.bind(transport);
    (transport as { send: unknown }).send = (data: string) => {
      original(data);
      if (data === 'Q') {
        transport.serverClose({ code: 1006 });
      }
    };
    await expect(service.resolveArticleId({ board: 'Dev', listNumber: 2 })).rejects.toBeInstanceOf(
      ConnectionClosedError
    );
    await expect(service.getBoardPage('Dev')).rejects.toBeInstanceOf(ConnectionClosedError);
    expect(Date.now() - started).toBeLessThan(2000); // a step timeout alone is 5 s
  });
});

describe('failing fast when the list is not what the tree thought (found while testing the UI)', () => {
  it('reports a row that no longer exists as a changed list within a couple of seconds, not as a timeout', async () => {
    const { service } = await setup({ Dev: board(5) });
    const started = Date.now();
    const error = await service.getArticle({ board: 'Dev', listNumber: 9 }).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleMismatchError);
    expect(Date.now() - started).toBeLessThan(3000); // the step timeout alone is 5 s
    // and the session is fine afterwards
    expect((await service.getArticle({ board: 'Dev', listNumber: 2 })).title).toBe('[測試] 第2篇');
  });

  it('says a board does not exist as soon as the menu comes back, without waiting out the timeout', async () => {
    const { service } = await setup({ Dev: board(3) }, { service: { boardEnterTimeoutMs: 5000 } });
    const started = Date.now();
    expect(await service.openBoard('Nope')).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await service.openBoard('Dev')).toBe(true);
  });
});

describe('a slow server is not mistaken for a missing row', () => {
  it('still finds a row that exists when every answer takes longer than the first look', async () => {
    const { service, transport } = await setup({ Dev: board(5) });
    await service.getBoardPage('Dev'); // enter the board at normal speed

    // From now on the server answers 700 ms late, but still in order, like a slow link.
    const original = transport.send.bind(transport);
    (transport as { send: unknown }).send = (data: string) => {
      setTimeout(() => original(data), 700);
    };

    const resolved = await service.resolveArticleId({ board: 'Dev', listNumber: 2 });
    expect(resolved.id).toBe('M.1002.A.002');
  }, 30_000);
});
