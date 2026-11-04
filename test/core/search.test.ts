import { describe, expect, it } from 'vitest';
import { ArticleMismatchError, InvalidArgumentError } from '../../src/core/errors';
import type { SearchQuery } from '../../src/core/models';
import { PttService } from '../../src/core/service';
import { describeSearch, toSearchInput } from '../../src/core/search';
import { Session } from '../../src/core/session/session';
import { isMainMenu, isNoSearchResult, isSearchPrompt } from '../../src/core/screens/prompts';
import { FakeBbs, type FakeArticle } from '../fakes/fakeBbs';

function article(i: number, extra: Partial<FakeArticle> = {}): FakeArticle {
  return {
    id: `M.${1000 + i}.A.${String(i).padStart(3, '0')}`,
    author: `user${i % 5}`,
    title: i % 3 === 0 ? `[討論] 人月神話 ${i}` : `[測試] 第${i}篇`,
    push: String(i % 100),
    body: [`body of ${i}`],
    ...extra,
  };
}

async function setup(articles: FakeArticle[]) {
  const bbs = new FakeBbs({ boards: { Dev: articles } });
  const session = new Session(bbs.connect(), { keepAliveMs: 0 });
  const service = new PttService(session, { boardEnterTimeoutMs: 150 });
  await service.login({ username: 'alice', password: 'secret' });
  return { bbs, session, service };
}

const title = (text: string): SearchQuery => ({ kind: 'title', text });

describe('searching a board', () => {
  it('lists the matches newest first, numbered within the results', async () => {
    const { service } = await setup(Array.from({ length: 30 }, (_, i) => article(i + 1)));

    const page = await service.searchBoard('Dev', title('人月'));

    expect(page.pinned).toEqual([]);
    expect(page.articles.map((a) => a.title)).toEqual(
      [30, 27, 24, 21, 18, 15, 12, 9, 6, 3].map((i) => `[討論] 人月神話 ${i}`)
    );
    expect(page.articles.map((a) => a.listNumber)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(page.articles.every((a) => a.search?.kind === 'title')).toBe(true);
    expect(page.hasOlder).toBe(false);
  });

  it('searches by author and by push count (and boos with a negative number)', async () => {
    const articles = Array.from({ length: 12 }, (_, i) => article(i + 1));
    articles[3] = article(4, { author: 'target', push: '50' });
    articles[8] = article(9, { author: 'target2', push: '爆', boo: 7 });
    const { service, bbs } = await setup(articles);

    const byAuthor = await service.searchBoard('Dev', { kind: 'author', text: 'target' });
    expect(byAuthor.articles.map((a) => a.author)).toEqual(['target2', 'target']);

    const byPush = await service.searchBoard('Dev', { kind: 'push', threshold: 40 });
    expect(byPush.articles.map((a) => a.author)).toEqual(['target2', 'target']);

    const byBoo = await service.searchBoard('Dev', { kind: 'push', threshold: -5 });
    expect(byBoo.articles.map((a) => a.author)).toEqual(['target2']);

    expect(bbs.searches).toEqual([
      ['a', 'target'],
      ['Z', '40'],
      ['Z', '-5'],
    ]);
  });

  it('pages back through more than one screen of results', async () => {
    const { service } = await setup(
      Array.from({ length: 120 }, (_, i) => article(i + 1, { title: `hit ${i + 1}` }))
    );

    const first = await service.searchBoard('Dev', title('hit'));
    expect(first.articles).toHaveLength(20);
    expect(first.articles[0]!.listNumber).toBe(120);
    expect(first.hasOlder).toBe(true);

    const numbers = first.articles.map((a) => a.listNumber!);
    let cursor = first.next;
    while (cursor) {
      const page = await service.searchBoard('Dev', title('hit'), cursor);
      numbers.push(...page.articles.map((a) => a.listNumber!));
      cursor = page.next;
    }
    expect(numbers).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i)); // no gap, no repeat
  });

  it('returns an empty result, and the board still works afterwards', async () => {
    const { service } = await setup(Array.from({ length: 10 }, (_, i) => article(i + 1)));

    const none = await service.searchBoard('Dev', title('沒有這個字'));
    expect(none).toMatchObject({ articles: [], pinned: [], hasOlder: false });

    const normal = await service.getBoardPage('Dev');
    expect(normal.articles[0]!.listNumber).toBe(10);
  });

  it('opens the article that was clicked, even though the number is a result number', async () => {
    const { service, session } = await setup(Array.from({ length: 30 }, (_, i) => article(i + 1)));
    const page = await service.searchBoard('Dev', title('人月'));
    const hit = page.articles[3]!; // result 7 of 10, which is article 21 in the board

    const opened = await service.getArticle({
      board: 'Dev',
      listNumber: hit.listNumber,
      title: hit.title,
      author: hit.author,
      search: hit.search,
    });

    expect(opened.id).toBe('M.1021.A.021');
    expect(opened.verified).toBe(true);
    // and the normal list still works from wherever the session was left
    expect((await service.getBoardPage('Dev')).articles[0]!.listNumber).toBe(30);
    expect(session.state).toBe('ready');
  });

  it('refuses a result whose number now points at another article', async () => {
    const { service, bbs } = await setup(Array.from({ length: 30 }, (_, i) => article(i + 1)));
    const page = await service.searchBoard('Dev', title('人月'));
    const hit = page.articles[3]!;

    bbs.mutate('Dev', (all) => all.splice(0, 3)); // older articles deleted: the results shift

    await expect(
      service.getArticle({
        board: 'Dev',
        listNumber: hit.listNumber,
        title: hit.title,
        author: hit.author,
        search: hit.search,
      })
    ).rejects.toBeInstanceOf(ArticleMismatchError);
  });

  it('a failed search walks back out of the result list to the main menu', async () => {
    const { service, session } = await setup(Array.from({ length: 10 }, (_, i) => article(i + 1)));
    await service.searchBoard('Dev', title('第')); // leaves the session wherever the last operation ended
    await expect(service.getFavorites()).resolves.toEqual([]); // starts from the main menu
    expect(session.lines[0]).toContain('看板列表');
  });

  it('caches a search page like a board page', async () => {
    const { service, bbs } = await setup(Array.from({ length: 10 }, (_, i) => article(i + 1)));
    await service.searchBoard('Dev', title('第'));
    await service.searchBoard('Dev', title('第'));
    expect(bbs.searches).toHaveLength(1);
  });
});

describe('what may be typed into the search prompt', () => {
  it.each<[string, SearchQuery]>([
    ['empty title', title('   ')],
    ['title with a control character', title('a\rb')],
    ['title with an escape sequence', title('\x1b[A')],
    ['title that is far too long', title('x'.repeat(31))],
    ['title that is short but too many bytes', title('中'.repeat(21))],
    ['title with an invisible direction override', title('abc‮def')],
    ['title with a line separator', title('abc def')],
    ['title with a next-line control', title('abc\u0085def')],
    ['author with a space', { kind: 'author', text: 'a b' }],
    ['author with a newline', { kind: 'author', text: 'abc\n' }],
    ['author that is too long', { kind: 'author', text: 'a'.repeat(13) }],
    ['push threshold that is not a whole number', { kind: 'push', threshold: 1.5 }],
    ['push threshold in exponent form', { kind: 'push', threshold: 1e21 }],
    ['push threshold out of range', { kind: 'push', threshold: 101 }],
    ['push threshold that is not a number', { kind: 'push', threshold: Number.NaN }],
    ['unknown kind', { kind: 'body', text: 'x' } as unknown as SearchQuery],
  ])('rejects %s before anything is sent', async (_name, query) => {
    const { service, session } = await setup([article(1)]);
    const sent: string[] = [];
    const original = session.send.bind(session);
    session.send = (...keys: string[]) => {
      sent.push(...keys);
      original(...keys);
    };

    await expect(service.searchBoard('Dev', query)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(sent).toEqual([]);
  });

  it('accepts ordinary queries and trims the title', () => {
    expect(toSearchInput(title('  人月  '))).toEqual({ key: '/', text: '人月' });
    expect(toSearchInput({ kind: 'author', text: 'User_01' })).toEqual({
      key: 'a',
      text: 'User_01',
    });
    expect(toSearchInput({ kind: 'push', threshold: -3 })).toEqual({ key: 'Z', text: '-3' });
  });

  it('refuses a search reference that also claims to be pinned', async () => {
    const { service } = await setup([article(1)]);
    await expect(
      service.getArticle({ board: 'Dev', isPinned: true, pinnedIndex: 0, search: title('x') })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('describes a query for display', () => {
    expect(describeSearch(title('人月'))).toBe('標題「人月」');
    expect(describeSearch({ kind: 'author', text: 'bob' })).toBe('作者 bob');
    expect(describeSearch({ kind: 'push', threshold: 10 })).toBe('推文數超過 10');
    expect(describeSearch({ kind: 'push', threshold: -4 })).toBe('噓文數超過 4');
  });
});

describe('getting out of the search screens', () => {
  const waitFor = async (session: Session, predicate: (l: string[]) => boolean) =>
    session.waitFor((l) => (predicate(l) ? true : false), 'the screen');

  it('toMainMenu cancels the search prompt instead of typing into it', async () => {
    const { service, session, bbs } = await setup([article(1)]);
    await service.openBoard('Dev');
    await session.run(async () => {
      session.send('/');
      await waitFor(session, isSearchPrompt);
      await session.toMainMenu();
    });
    expect(isMainMenu(session.lines)).toBe(true);
    expect(bbs.searches).toEqual([]);
  });

  it('toMainMenu closes the "nothing found" notice', async () => {
    const { service, session } = await setup([article(1)]);
    await service.openBoard('Dev');
    await session.run(async () => {
      session.send('/');
      await waitFor(session, isSearchPrompt);
      session.send('nothing', '\r');
      await waitFor(session, isNoSearchResult);
      await session.toMainMenu();
    });
    expect(isMainMenu(session.lines)).toBe(true);
  });

  it('a title that imitates a prompt or the notice does not fool the search', async () => {
    const hostile = article(1, {
      title: '搜尋標題: 找不到符合條件的文章 請按任意鍵繼續',
    });
    const { service } = await setup([hostile, article(2)]);

    const hits = await service.searchBoard('Dev', title('找不到'));
    expect(hits.articles.map((a) => a.listNumber)).toEqual([1]);
    expect((await service.searchBoard('Dev', title('完全沒有'))).articles).toEqual([]);
    expect((await service.getBoardPage('Dev')).articles).toHaveLength(2);
  });

  it('refuses an invalid search inside a reference before touching the server', async () => {
    const { service, session } = await setup([article(1)]);
    const sent: string[] = [];
    const original = session.send.bind(session);
    session.send = (...keys: string[]) => {
      sent.push(...keys);
      original(...keys);
    };
    const bad = { board: 'Dev', listNumber: 1, search: title('a\rb') };

    await expect(service.getArticle(bad)).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(service.resolveArticleId(bad)).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(sent).toEqual([]);
  });

  it('treats the same search written differently as one search', async () => {
    const { service, bbs } = await setup(Array.from({ length: 6 }, (_, i) => article(i + 1)));
    await service.searchBoard('Dev', { kind: 'title', text: ' 第 ' });
    await service.searchBoard('Dev', { kind: 'title', text: '第', extra: 'ignored' } as never);
    expect(bbs.searches).toHaveLength(1);
  });
});
