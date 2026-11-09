import { describe, expect, it } from 'vitest';
import { aidFromId, idFromAid, parseArticleAddress } from '../../src/core/aid';

describe('article codes', () => {
  // Both pairs were read off live `Q` boxes (test/core/screens.test.ts).
  it.each([
    ['M.1793499440.A.938', '#1gvg4mau'],
    ['M.1501827536.A.DF2', '#1PX17Gto'],
  ])('%s <-> %s', (id, aid) => {
    expect(aidFromId(id)).toBe(aid);
    expect(idFromAid(aid)).toBe(id);
    expect(idFromAid(aid.slice(1))).toBe(id);
  });

  it('refuses what is not an ordinary article', () => {
    expect(aidFromId('G.1.A.001')).toBeUndefined();
    expect(aidFromId('M.99999999999.A.001')).toBeUndefined();
    expect(idFromAid('#1gvg4ma')).toBeUndefined();
    expect(idFromAid('#1gvg4ma!')).toBeUndefined();
    expect(idFromAid('#Zgvg4mau')).toBeUndefined(); // type bits set: not an "M" file
  });
});

describe('parseArticleAddress', () => {
  it('reads a URL, a code with its board, and a bare code', () => {
    expect(
      parseArticleAddress(' https://www.ptt.cc/bbs/Soft_Job/M.1793499440.A.938.html ')
    ).toEqual({ board: 'Soft_Job', id: 'M.1793499440.A.938' });
    expect(parseArticleAddress('#1gvg4mau (Soft_Job)')).toEqual({
      board: 'Soft_Job',
      id: 'M.1793499440.A.938',
    });
    expect(parseArticleAddress('1gvg4mau')).toEqual({ id: 'M.1793499440.A.938' });
  });

  it('refuses anything else', () => {
    for (const text of [
      '',
      'https://evil.example/bbs/Soft_Job/M.1.A.001.html',
      'https://www.ptt.cc/bbs/Bad Board/M.1.A.001.html',
      '#1gvg4mau (bad board)',
      '#1gvg4mau extra',
    ]) {
      expect(parseArticleAddress(text)).toBeUndefined();
    }
  });
});
