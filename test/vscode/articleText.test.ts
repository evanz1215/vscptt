import { describe, expect, it } from 'vitest';
import type { Article } from '../../src/core/models';
import { renderArticle, renderArticleError } from '../../src/vscode/articleText';

const RULE = '──────────────────────────────';

const article = (extra: Partial<Article> = {}): Article => ({
  board: 'Dev',
  id: 'M.1.A.001',
  aid: '#1abc',
  url: 'https://www.ptt.cc/bbs/Dev/M.1.A.001.html',
  title: '[測試] 標題',
  author: 'alice (Alice)',
  time: 'Sun Nov  1 10:17:18 2026',
  bodyLines: ['first line', 'second line'],
  pushes: [
    { kind: '推', userId: 'bob', content: 'nice', date: '11/01', time: '10:40' },
    { kind: '→', userId: 'carol', content: 'old post', date: '09/03' },
  ],
  verified: true,
  pinnedMirror: false,
  truncated: false,
  ...extra,
});

describe('renderArticle', () => {
  it('lays out the header, the body and the pushes', () => {
    expect(renderArticle(article())).toBe(
      [
        '標題：[測試] 標題',
        '作者：alice (Alice)',
        '看板：Dev',
        '時間：Sun Nov  1 10:17:18 2026',
        '網址：https://www.ptt.cc/bbs/Dev/M.1.A.001.html',
        '推文：推 1・噓 0・→ 1（共 2 則）',
        RULE,
        'first line',
        'second line',
        RULE,
        '推 bob: nice    11/01 10:40',
        '→ carol: old post    09/03',
        '',
      ].join('\n')
    );
  });

  it('leaves out the push section when there are no pushes', () => {
    const text = renderArticle(article({ pushes: [] }));
    expect(text.split(RULE)).toHaveLength(2); // exactly one rule
    expect(text).not.toContain('推文：');
  });

  it('says so when the content could not be checked against the list entry', () => {
    expect(renderArticle(article({ verified: false }))).toContain(
      '無法把這篇文章的內容和清單項目核對'
    );
  });

  it('says so for a pinned copy and for a cut-off article', () => {
    const text = renderArticle(article({ pinnedMirror: true, truncated: true }));
    expect(text).toContain('這是置頂文，內容來自另一篇文章');
    expect(text).toContain('只顯示前面的部分');
  });

  it('adds no notices to an ordinary verified article', () => {
    expect(renderArticle(article())).not.toContain('※');
  });

  it('copes with a missing URL', () => {
    expect(renderArticle(article({ url: undefined }))).toContain('網址：\n');
  });
});

describe('renderArticleError', () => {
  it('is never empty and carries the message', () => {
    const text = renderArticleError('看板清單已經變動');
    expect(text).toContain('無法開啟這篇文章');
    expect(text).toContain('看板清單已經變動');
  });
});
