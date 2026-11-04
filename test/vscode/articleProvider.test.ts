import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { ArticleMismatchError, ConnectionClosedError } from '../../src/core/errors';
import type { Article, ArticleRef } from '../../src/core/models';
import {
  ARTICLE_SCHEME,
  ArticleContentProvider,
  type ArticleSource,
  articleUri,
  refFromUri,
} from '../../src/vscode/articleProvider';

const article = (): Article => ({
  board: 'Dev',
  id: 'M.1.A.001',
  aid: '#1abc',
  url: 'https://www.ptt.cc/bbs/Dev/M.1.A.001.html',
  title: '[測試] 標題',
  author: 'alice',
  time: 'now',
  bodyLines: ['hello'],
  pushes: [],
  verified: true,
  pinnedMirror: false,
  truncated: false,
});

class FakeSource implements ArticleSource {
  asked: ArticleRef[] = [];
  invalidated: Array<string | undefined> = [];
  fail: unknown;
  async getArticle(ref: ArticleRef): Promise<Article> {
    this.asked.push(ref);
    if (this.fail) {
      throw this.fail;
    }
    return article();
  }
  invalidate(board?: string): void {
    this.invalidated.push(board);
  }
}

const uriWith = (query: string) =>
  vscode.Uri.from({ scheme: ARTICLE_SCHEME, path: '/Dev/x.txt', query });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('article addresses', () => {
  const refs: ArticleRef[] = [
    { board: 'Dev', listNumber: 36731, title: '[請益] 中高齡找短期約聘軟工' },
    { board: 'Soft_Job', isPinned: true, pinnedIndex: 2, title: '[公告] 本板板規' },
    { board: 'Dev', listNumber: 5, title: '100% 真的?/\\:*"<>| #1 ?q=1&x=%20', id: 'M.1.A.001' },
  ];

  it.each(refs)('round-trips $title', (ref) => {
    const uri = articleUri(ref, ref.title ?? 'x');
    const restored = refFromUri(uri);
    expect(restored).toMatchObject(ref);
  });

  it('survives being turned into text and parsed again, as when a tab is restored', () => {
    for (const ref of refs) {
      const again = vscode.Uri.parse(articleUri(ref, ref.title ?? 'x').toString());
      expect(refFromUri(again)).toMatchObject(ref);
    }
  });

  it('names the tab after the board and a safe version of the title', () => {
    const uri = articleUri(refs[2]!, refs[2]!.title!);
    expect(uri.scheme).toBe('vscptt');
    const [, board, file, ...rest] = uri.path.split('/');
    expect(board).toBe('Dev');
    expect(rest).toEqual([]); // the title cannot add path segments
    expect(file).toMatch(/\.txt$/);
    expect(file).not.toMatch(/[\\?#%:*"<>|]/);
    expect(file!.length).toBeLessThanOrEqual(60);
  });

  it('falls back to a plain name for an empty or all-unsafe title', () => {
    expect(articleUri({ board: 'Dev', listNumber: 1 }, '///').path).toBe('/Dev/article.txt');
  });

  it('gives different articles different addresses', () => {
    const a = articleUri({ board: 'Dev', listNumber: 1, title: 'same' }, 'same').toString();
    const b = articleUri({ board: 'Dev', listNumber: 2, title: 'same' }, 'same').toString();
    expect(a).not.toBe(b);
  });
});

describe('addresses that are not ours are refused', () => {
  const bad: Array<[string, vscode.Uri]> = [
    ['wrong scheme', vscode.Uri.from({ scheme: 'file', path: '/x', query: b64({ board: 'Dev' }) })],
    ['empty query', uriWith('')],
    ['not base64 json', uriWith('!!!not-base64!!!')],
    ['json null', uriWith(b64(null))],
    ['json array', uriWith(b64([1, 2]))],
    ['board is not a string', uriWith(b64({ board: 5 }))],
    ['listNumber is a string', uriWith(b64({ board: 'Dev', listNumber: '3' }))],
    ['isPinned is a string', uriWith(b64({ board: 'Dev', isPinned: 'yes' }))],
    ['title is a number', uriWith(b64({ board: 'Dev', title: 3 }))],
  ];
  it.each(bad)('%s', (_name, uri) => {
    expect(refFromUri(uri)).toBeUndefined();
  });

  it('drops fields it does not know', () => {
    const ref = refFromUri(uriWith(b64({ board: 'Dev', listNumber: 3, evil: 'x' })));
    expect(ref).toEqual({
      board: 'Dev',
      listNumber: 3,
      pinnedIndex: undefined,
      isPinned: undefined,
      title: undefined,
      id: undefined,
    });
    expect(ref).not.toHaveProperty('evil');
  });
});

describe('ArticleContentProvider', () => {
  const uri = articleUri({ board: 'Dev', listNumber: 3, title: 't' }, 't');

  it('shows the article text', async () => {
    const source = new FakeSource();
    const text = await new ArticleContentProvider(() => source).provideTextDocumentContent(uri);
    expect(text).toContain('標題：[測試] 標題');
    expect(text).toContain('hello');
    expect(source.asked).toEqual([
      expect.objectContaining({ board: 'Dev', listNumber: 3, title: 't' }),
    ]);
  });

  it('shows a failure inside the document and also reports it, so a tab is never blank', async () => {
    const source = new FakeSource();
    source.fail = new ArticleMismatchError('internal detail');
    const reported: string[] = [];
    const provider = new ArticleContentProvider(
      () => source,
      (m) => reported.push(m)
    );

    const text = await provider.provideTextDocumentContent(uri);

    expect(text).toContain('無法開啟這篇文章');
    expect(text).toContain('清單已經變動');
    expect(text).not.toContain('internal detail');
    expect(reported).toEqual([expect.stringContaining('清單已經變動')]);
  });

  it('survives having no connection at all', async () => {
    const provider = new ArticleContentProvider(() => {
      throw new ConnectionClosedError();
    });
    expect(await provider.provideTextDocumentContent(uri)).toContain('連線已中斷');
  });

  it('does not ask the service for an address it did not make', async () => {
    const source = new FakeSource();
    const text = await new ArticleContentProvider(() => source).provideTextDocumentContent(
      uriWith('garbage')
    );
    expect(text).toContain('不是 vscptt 產生的');
    expect(source.asked).toEqual([]);
  });

  it('refresh() makes the editor read the article again and drops the cached copy', () => {
    const source = new FakeSource();
    const provider = new ArticleContentProvider(() => source);
    const changed: string[] = [];
    provider.onDidChange((u) => changed.push(u.toString()));

    provider.refresh(uri);

    expect(changed).toEqual([uri.toString()]);
    expect(source.invalidated).toEqual(['Dev']);
  });

  it('refresh() still redraws when there is no connection to forget anything on', () => {
    const provider = new ArticleContentProvider(() => {
      throw new ConnectionClosedError();
    });
    const changed: string[] = [];
    provider.onDidChange((u) => changed.push(u.toString()));
    expect(() => provider.refresh(uri)).not.toThrow();
    expect(changed).toHaveLength(1);
  });
});
